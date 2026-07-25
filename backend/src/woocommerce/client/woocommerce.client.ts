import axios from 'axios';

import type { WooCommerceRestSettings } from '../../config/configuration.types';

export interface WooCommerceClientOptions {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  resilience: Readonly<WooCommerceRestSettings>;
}

export interface WooCommerceConnectionResult {
  success: boolean;
  storeName?: string;
  error?: string;
  category?: WooCommerceErrorCategory;
}

export interface WooCommerceValidationResult {
  storeName?: string;
}

export const REQUIRED_ORDER_WEBHOOK_TOPICS = [
  'order.created',
  'order.updated',
  'order.deleted',
  'order.restored',
] as const;

interface WooCommerceWebhook {
  id: number;
  name: string;
  status: string;
  topic: string;
  deliveryUrl: string;
}

export type WooCommerceErrorCategory =
  | 'auth'
  | 'not-found'
  | 'transport'
  | 'rate-limited'
  | 'timeout'
  | 'unexpected';

const SAFE_ERROR_MESSAGES: Readonly<Record<WooCommerceErrorCategory, string>> =
  {
    auth: 'WooCommerce authentication failed',
    'not-found': 'WooCommerce resource was not found',
    transport: 'Unable to reach the WooCommerce store',
    'rate-limited': 'WooCommerce rate limit was exceeded',
    timeout: 'WooCommerce connection timed out',
    unexpected: 'WooCommerce connection failed unexpectedly',
  };

interface SystemStatusResponse {
  store_name?: unknown;
  name?: unknown;
}

interface ClassifiedFailure {
  error: WooCommerceClientError;
  retryable: boolean;
}

export class WooCommerceClientError extends Error {
  constructor(readonly category: WooCommerceErrorCategory) {
    super(SAFE_ERROR_MESSAGES[category]);
    this.name = 'WooCommerceClientError';
  }
}

export class WooCommerceClient {
  constructor(private readonly options: WooCommerceClientOptions) {}

  async validateCredentials(): Promise<WooCommerceValidationResult> {
    const data = await this.requestWithTotalTimeout<unknown>(
      this.validationUrl
    );
    const storeName = this.readStoreName(data);

    return storeName ? { storeName } : {};
  }

  fetchOrder(wcOrderId: string): Promise<unknown> {
    return this.requestWithTotalTimeout<unknown>(
      `${this.ordersUrl}/${encodeURIComponent(wcOrderId)}`
    );
  }

  updateOrderStatus(wcOrderId: string, status: string): Promise<unknown> {
    return this.writeWithTotalTimeout<unknown>(
      'put',
      `${this.ordersUrl}/${encodeURIComponent(wcOrderId)}`,
      { status }
    );
  }

  async ensureRequiredOrderWebhooks(
    deliveryUrl: string,
    webhookSecret: string
  ): Promise<void> {
    const existing = await this.listWebhooks();

    for (const topic of REQUIRED_ORDER_WEBHOOK_TOPICS) {
      const name = this.managedWebhookName(topic);
      const webhook =
        existing.find(
          (candidate) =>
            candidate.topic === topic && candidate.deliveryUrl === deliveryUrl
        ) ?? existing.find((candidate) => candidate.name === name);
      const body = {
        name,
        status: 'active',
        topic,
        delivery_url: deliveryUrl,
        secret: webhookSecret,
      };

      if (
        webhook?.name === name &&
        webhook.status === 'active' &&
        webhook.topic === topic &&
        webhook.deliveryUrl === deliveryUrl
      ) {
        continue;
      }

      if (webhook) {
        await this.writeWithTotalTimeout(
          'put',
          `${this.webhooksUrl}/${webhook.id}`,
          body
        );
      } else {
        await this.writeWithTotalTimeout('post', this.webhooksUrl, body);
      }
    }

    if (!(await this.hasRequiredOrderWebhooks(deliveryUrl))) {
      throw new WooCommerceClientError('unexpected');
    }
  }

  async hasRequiredOrderWebhooks(deliveryUrl: string): Promise<boolean> {
    const webhooks = await this.listWebhooks();

    return REQUIRED_ORDER_WEBHOOK_TOPICS.every((topic) =>
      webhooks.some(
        (webhook) =>
          webhook.topic === topic &&
          webhook.deliveryUrl === deliveryUrl &&
          webhook.status === 'active'
      )
    );
  }

  private async requestWithTotalTimeout<T>(url: string): Promise<T> {
    const controller = new AbortController();
    let totalTimeout: NodeJS.Timeout | undefined;
    const totalTimeoutPromise = new Promise<never>((_resolve, reject) => {
      totalTimeout = setTimeout(() => {
        controller.abort();
        reject(new WooCommerceClientError('timeout'));
      }, this.options.resilience.totalTimeoutMs);
    });

    try {
      return await Promise.race([
        this.getWithRetries<T>(url, controller.signal),
        totalTimeoutPromise,
      ]);
    } finally {
      if (totalTimeout) {
        clearTimeout(totalTimeout);
      }
    }
  }

  async testConnection(): Promise<WooCommerceConnectionResult> {
    try {
      const result = await this.validateCredentials();

      return {
        success: true,
        ...(result.storeName ? { storeName: result.storeName } : {}),
      };
    } catch (error: unknown) {
      const normalized =
        error instanceof WooCommerceClientError
          ? error
          : new WooCommerceClientError('unexpected');

      return {
        success: false,
        error: normalized.message,
        category: normalized.category,
      };
    }
  }

  private async writeWithTotalTimeout<T>(
    method: 'post' | 'put',
    url: string,
    body: Readonly<Record<string, string>>
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.resilience.totalTimeoutMs
    );

    try {
      const request = {
        auth: {
          username: this.options.consumerKey,
          password: this.options.consumerSecret,
        },
        signal: controller.signal,
        timeout: this.options.resilience.attemptTimeoutMs,
      };
      const response =
        method === 'put'
          ? await axios.put<T>(url, body, request)
          : await axios.post<T>(url, body, request);

      return response.data;
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        throw new WooCommerceClientError('timeout');
      }

      throw this.classifyFailure(error).error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getWithRetries<T>(
    url: string,
    signal: AbortSignal
  ): Promise<T> {
    for (
      let attempt = 1;
      attempt <= this.options.resilience.maxAttempts;
      attempt += 1
    ) {
      try {
        const response = await axios.get<T>(url, {
          auth: {
            username: this.options.consumerKey,
            password: this.options.consumerSecret,
          },
          signal,
          timeout: this.options.resilience.attemptTimeoutMs,
        });
        return response.data;
      } catch (error: unknown) {
        if (signal.aborted) {
          throw new WooCommerceClientError('timeout');
        }

        const failure = this.classifyFailure(error);
        const attemptsRemain = attempt < this.options.resilience.maxAttempts;

        if (!failure.retryable || !attemptsRemain) {
          throw failure.error;
        }

        await this.waitForRetry(attempt, signal);
      }
    }

    throw new WooCommerceClientError('unexpected');
  }

  private classifyFailure(error: unknown): ClassifiedFailure {
    if (!axios.isAxiosError(error)) {
      return {
        error: new WooCommerceClientError('unexpected'),
        retryable: false,
      };
    }

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return {
        error: new WooCommerceClientError('timeout'),
        retryable: true,
      };
    }

    const status = error.response?.status;

    if (status === undefined) {
      return {
        error: new WooCommerceClientError('transport'),
        retryable: true,
      };
    }

    if (status === 401 || status === 403) {
      return {
        error: new WooCommerceClientError('auth'),
        retryable: false,
      };
    }

    if (status === 404) {
      return {
        error: new WooCommerceClientError('not-found'),
        retryable: false,
      };
    }

    if (status === 429) {
      return {
        error: new WooCommerceClientError('rate-limited'),
        retryable: true,
      };
    }

    if (status >= 500) {
      return {
        error: new WooCommerceClientError('transport'),
        retryable: true,
      };
    }

    return {
      error: new WooCommerceClientError('unexpected'),
      retryable: false,
    };
  }

  private waitForRetry(attempt: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(new WooCommerceClientError('timeout'));
    }

    const exponentialDelay =
      this.options.resilience.backoffBaseMs *
      this.options.resilience.backoffFactor ** (attempt - 1);
    const jitterMultiplier =
      1 + (Math.random() * 2 - 1) * this.options.resilience.jitterRatio;
    const delay = Math.max(0, Math.round(exponentialDelay * jitterMultiplier));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, delay);
      const abort = (): void => {
        clearTimeout(timeout);
        reject(new WooCommerceClientError('timeout'));
      };

      signal.addEventListener('abort', abort, { once: true });
    });
  }

  private get validationUrl(): string {
    return `${this.options.storeUrl.replace(/\/+$/, '')}/wp-json/wc/v3/system_status`;
  }

  private get ordersUrl(): string {
    return `${this.options.storeUrl.replace(/\/+$/, '')}/wp-json/wc/v3/orders`;
  }

  private get webhooksUrl(): string {
    return `${this.options.storeUrl.replace(/\/+$/, '')}/wp-json/wc/v3/webhooks`;
  }

  private async listWebhooks(): Promise<WooCommerceWebhook[]> {
    const data = await this.requestWithTotalTimeout<unknown>(
      `${this.webhooksUrl}?per_page=100`
    );

    if (!Array.isArray(data)) {
      throw new WooCommerceClientError('unexpected');
    }

    return data.flatMap((candidate) => {
      if (candidate === null || typeof candidate !== 'object') {
        return [];
      }

      const value = candidate as Record<string, unknown>;
      const id = value['id'];
      const name = value['name'];
      const status = value['status'];
      const topic = value['topic'];
      const deliveryUrl = value['delivery_url'];

      return typeof id === 'number' &&
        Number.isSafeInteger(id) &&
        typeof name === 'string' &&
        typeof status === 'string' &&
        typeof topic === 'string' &&
        typeof deliveryUrl === 'string'
        ? [{ id, name, status, topic, deliveryUrl }]
        : [];
    });
  }

  private managedWebhookName(topic: string): string {
    return `WC Telegram private pilot: ${topic}`;
  }

  private readStoreName(value: unknown): string | undefined {
    if (value === null || typeof value !== 'object') {
      return undefined;
    }

    const status = value as SystemStatusResponse;
    const candidate = status.store_name ?? status.name;

    return typeof candidate === 'string' && candidate.trim() !== ''
      ? candidate
      : undefined;
  }
}
