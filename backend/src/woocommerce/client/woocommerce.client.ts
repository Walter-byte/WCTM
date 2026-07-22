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
    'not-found': 'WooCommerce validation endpoint was not found',
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
        this.probeWithRetries(controller.signal),
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

  private async probeWithRetries(
    signal: AbortSignal
  ): Promise<WooCommerceValidationResult> {
    for (
      let attempt = 1;
      attempt <= this.options.resilience.maxAttempts;
      attempt += 1
    ) {
      try {
        const response = await axios.get<unknown>(this.validationUrl, {
          auth: {
            username: this.options.consumerKey,
            password: this.options.consumerSecret,
          },
          signal,
          timeout: this.options.resilience.attemptTimeoutMs,
        });
        const storeName = this.readStoreName(response.data);

        return storeName ? { storeName } : {};
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
