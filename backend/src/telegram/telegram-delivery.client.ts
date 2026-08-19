import { Inject, Injectable, Optional } from '@nestjs/common';

import { ApplicationConfigService } from '../config/application-config.service';

export interface PreparedTelegramMessage {
  chatId: string;
  text: string;
  buttons: Array<{ text: string; callbackData: string }>;
}

export type TelegramDeliveryResult =
  | { outcome: 'delivered'; messageId: string }
  | {
      outcome: 'retryable_failure' | 'terminal_failure' | 'ambiguous';
      category: string;
      code: string;
    };

export const TELEGRAM_DELIVERY_FETCH = Symbol('TELEGRAM_DELIVERY_FETCH');

@Injectable()
export class TelegramDeliveryClient {
  private readonly request: typeof fetch;

  constructor(
    private readonly configuration: ApplicationConfigService,
    @Optional()
    @Inject(TELEGRAM_DELIVERY_FETCH)
    request?: typeof fetch
  ) {
    this.request = request ?? fetch;
  }

  async send(
    message: PreparedTelegramMessage
  ): Promise<TelegramDeliveryResult> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.configuration.telegram.deliveryTimeoutMs
    );

    try {
      const response = await this.request(
        `${this.configuration.telegram.botInternalUrl.replace(/\/+$/, '')}/internal/send-message`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-bot-api-key': this.configuration.telegram.internalApiKey,
          },
          body: JSON.stringify(message),
          signal: controller.signal,
        }
      );

      if (response.status === 401 || response.status === 403) {
        return {
          outcome: 'terminal_failure',
          category: 'authentication',
          code: 'bot-authentication-failed',
        };
      }

      if (response.status === 400) {
        return {
          outcome: 'terminal_failure',
          category: 'request',
          code: 'bot-request-rejected',
        };
      }

      if (!response.ok) {
        return ambiguousResult();
      }

      return parseDeliveryResult(await response.json());
    } catch {
      return ambiguousResult();
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseDeliveryResult(value: unknown): TelegramDeliveryResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ambiguousResult();
  }

  const record = value as Record<string, unknown>;

  if (
    record['outcome'] === 'delivered' &&
    typeof record['messageId'] === 'string' &&
    /^[1-9]\d{0,18}$/.test(record['messageId'])
  ) {
    return { outcome: 'delivered', messageId: record['messageId'] };
  }

  if (
    (record['outcome'] === 'retryable_failure' ||
      record['outcome'] === 'terminal_failure' ||
      record['outcome'] === 'ambiguous') &&
    typeof record['category'] === 'string' &&
    /^[a-z-]{1,32}$/.test(record['category']) &&
    typeof record['code'] === 'string' &&
    /^[a-z0-9-]{1,191}$/.test(record['code'])
  ) {
    return {
      outcome: record['outcome'],
      category: record['category'],
      code: record['code'],
    };
  }

  return ambiguousResult();
}

function ambiguousResult(): TelegramDeliveryResult {
  return {
    outcome: 'ambiguous',
    category: 'transport',
    code: 'bot-outcome-unknown',
  };
}
