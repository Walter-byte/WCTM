import { GrammyError, HttpError, InlineKeyboard, type Api } from 'grammy';
import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import type { BotConfiguration } from './config';
import {
  formatMoney,
  formatNumber,
  inventoryLabel,
  isolateLtr,
  resolveLanguage,
  statusLabel,
  translate,
  type PresentationMetadata,
} from './localization';

const MAX_BODY_BYTES = 16 * 1024;
const CALLBACK_PATTERN =
  /^(?:(?:d|v)\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}|t:d\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16})$/;

type PreparedTelegramNotification =
  | {
      type: 'ORDER_CREATED';
      orderNumber: string;
      status: string;
      currency: string;
      total: string;
      customerDisplayName: string;
      viewOrderRef: string;
      changeStatusAvailable: boolean;
    }
  | {
      type: 'LOW_STOCK' | 'OUT_OF_STOCK';
      displayName: string;
      sku: string | null;
      quantity: string | null;
      stockStatus: string;
      threshold: number | null;
      viewStockRef: string;
    };

export interface PreparedTelegramMessage {
  chatId: string;
  presentation: PresentationMetadata;
  notification: PreparedTelegramNotification;
}

export type TelegramDeliveryResult =
  | { outcome: 'delivered'; messageId: string }
  | {
      outcome: 'retryable_failure' | 'terminal_failure' | 'ambiguous';
      category: string;
      code: string;
    };

export class InternalDeliveryServer {
  private readonly server: Server;

  constructor(
    private readonly configuration: Pick<
      BotConfiguration,
      'internalApiKey' | 'internalPort'
    >,
    private readonly api: Pick<Api, 'sendMessage'>
  ) {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.configuration.internalPort, '0.0.0.0', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.server.listening) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  address(): { port: number } | undefined {
    const address = this.server.address();

    return address && typeof address === 'object'
      ? { port: address.port }
      : undefined;
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/internal/send-message') {
      this.respond(response, 404, { error: 'not_found' });
      return;
    }

    if (!this.authenticated(request.headers['x-bot-api-key'])) {
      this.respond(response, 401, { error: 'unauthorized' });
      return;
    }

    let input: PreparedTelegramMessage;

    try {
      input = validatePreparedMessage(await readJsonBody(request));
    } catch {
      this.respond(response, 400, { error: 'invalid_request' });
      return;
    }

    const result = await this.deliver(input);
    this.respond(response, 200, result);
  }

  private async deliver(
    input: PreparedTelegramMessage
  ): Promise<TelegramDeliveryResult> {
    const rendered = renderPreparedNotification(input);
    const keyboard = new InlineKeyboard();

    for (const button of rendered.buttons) {
      keyboard.text(button.text, button.callbackData);
    }

    try {
      const message = await this.api.sendMessage(input.chatId, rendered.text, {
        reply_markup: keyboard,
      });

      return {
        outcome: 'delivered',
        messageId: message.message_id.toString(),
      };
    } catch (error: unknown) {
      if (error instanceof GrammyError) {
        if (error.error_code === 429) {
          return {
            outcome: 'retryable_failure',
            category: 'rate-limited',
            code: 'telegram-rate-limited',
          };
        }

        if (error.error_code >= 500) {
          return {
            outcome: 'retryable_failure',
            category: 'server',
            code: 'telegram-server-error',
          };
        }

        return {
          outcome: 'terminal_failure',
          category: error.error_code === 403 ? 'forbidden' : 'request',
          code:
            error.error_code === 403
              ? 'telegram-chat-forbidden'
              : 'telegram-request-rejected',
        };
      }

      return {
        outcome: 'ambiguous',
        category: error instanceof HttpError ? 'transport' : 'unexpected',
        code: 'telegram-outcome-unknown',
      };
    }
  }

  private authenticated(value: string | string[] | undefined): boolean {
    const presented = Array.isArray(value) ? value[0] : value;

    if (!presented) {
      return false;
    }

    const expected = Buffer.from(this.configuration.internalApiKey);
    const actual = Buffer.from(presented);

    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  private respond(
    response: ServerResponse,
    statusCode: number,
    body: Readonly<Record<string, unknown>>
  ): void {
    response.writeHead(statusCode, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;

    if (length > MAX_BODY_BYTES) {
      throw new Error('Request body is too large');
    }

    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function validatePreparedMessage(value: unknown): PreparedTelegramMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Prepared message must be an object');
  }

  const record = value as Record<string, unknown>;
  const presentation = record['presentation'];
  const notification = record['notification'];

  if (
    typeof record['chatId'] !== 'string' ||
    !/^-?[1-9]\d{0,18}$/.test(record['chatId']) ||
    !isPresentation(presentation) ||
    notification === null ||
    typeof notification !== 'object' ||
    Array.isArray(notification)
  ) {
    throw new Error('Prepared message is invalid');
  }

  const preparedNotification = validateNotification(
    notification as Record<string, unknown>
  );

  return {
    chatId: record['chatId'],
    presentation,
    notification: preparedNotification,
  };
}

export function renderPreparedNotification(input: PreparedTelegramMessage): {
  text: string;
  buttons: Array<{ text: string; callbackData: string }>;
} {
  const language = resolveLanguage(input.presentation.language);
  const notification = input.notification;

  if (notification.type === 'ORDER_CREATED') {
    return {
      text: [
        translate(language, 'notification.newOrder'),
        translate(language, 'orders.order', {
          number: isolateLtr(notification.orderNumber),
        }),
        translate(language, 'orders.status', {
          value: statusLabel(notification.status, language),
        }),
        translate(language, 'orders.total', {
          value: formatMoney(
            notification.total,
            notification.currency,
            language
          ),
        }),
        translate(language, 'orders.customer', {
          value: safeDisplay(notification.customerDisplayName, 255),
        }),
      ].join('\n'),
      buttons: [
        {
          text: translate(language, 'action.viewOrder'),
          callbackData: notification.viewOrderRef,
        },
        ...(notification.changeStatusAvailable
          ? [
              {
                text: translate(language, 'action.changeStatus'),
                callbackData: `t:${notification.viewOrderRef}`,
              },
            ]
          : []),
      ],
    };
  }

  const classification =
    notification.type === 'OUT_OF_STOCK' ? 'OUT_OF_STOCK' : 'LOW_STOCK';

  return {
    text: [
      translate(
        language,
        notification.type === 'OUT_OF_STOCK'
          ? 'notification.outOfStock'
          : 'notification.lowStock'
      ),
      safeDisplay(notification.displayName, 255),
      ...(notification.sku
        ? [
            translate(language, 'stock.sku', {
              value: isolateLtr(notification.sku),
            }),
          ]
        : []),
      translate(language, 'stock.quantity', {
        value:
          notification.quantity === null
            ? translate(language, 'general.notManaged')
            : formatNumber(notification.quantity, language),
      }),
      translate(language, 'stock.wooStatus', {
        value: isolateLtr(notification.stockStatus),
      }),
      translate(language, 'stock.wctmClass', {
        value: inventoryLabel(classification, language),
      }),
      translate(language, 'stock.wctmThreshold', {
        value:
          notification.threshold === null
            ? translate(language, 'general.notConfigured')
            : formatNumber(notification.threshold, language),
      }),
    ].join('\n'),
    buttons: [
      {
        text: translate(language, 'action.viewStock'),
        callbackData: notification.viewStockRef,
      },
    ],
  };
}

function validateNotification(
  record: Record<string, unknown>
): PreparedTelegramNotification {
  if (record['type'] === 'ORDER_CREATED') {
    if (typeof record['changeStatusAvailable'] !== 'boolean') {
      throw new Error('Prepared notification is invalid');
    }

    const result = {
      type: record['type'],
      orderNumber: requiredString(record['orderNumber'], 191),
      status: requiredString(record['status'], 64),
      currency: requiredString(record['currency'], 16),
      total: requiredString(record['total'], 64),
      customerDisplayName: requiredString(record['customerDisplayName'], 255),
      viewOrderRef: callback(record['viewOrderRef'], 'd.'),
      changeStatusAvailable: record['changeStatusAvailable'],
    } as const;

    return result;
  }

  if (record['type'] === 'LOW_STOCK' || record['type'] === 'OUT_OF_STOCK') {
    const quantity = nullableString(record['quantity'], 64);
    const sku = nullableString(record['sku'], 191);
    const threshold = record['threshold'];

    if (
      threshold !== null &&
      (typeof threshold !== 'number' ||
        !Number.isSafeInteger(threshold) ||
        threshold < 0)
    ) {
      throw new Error('Prepared notification is invalid');
    }

    return {
      type: record['type'],
      displayName: requiredString(record['displayName'], 255),
      sku,
      quantity,
      stockStatus: requiredString(record['stockStatus'], 32),
      threshold,
      viewStockRef: callback(record['viewStockRef'], 'v.'),
    };
  }

  throw new Error('Prepared notification is invalid');
}

function isPresentation(value: unknown): value is PresentationMetadata {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record['language'] === 'string' &&
    record['language'].length >= 1 &&
    record['language'].length <= 16 &&
    typeof record['timezone'] === 'string' &&
    record['timezone'].length >= 1 &&
    record['timezone'].length <= 64
  );
}

function requiredString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new Error('Prepared notification is invalid');
  }
  return value;
}

function nullableString(value: unknown, maximum: number): string | null {
  if (value === null) {
    return null;
  }
  return requiredString(value, maximum);
}

function callback(value: unknown, prefix: 'd.' | 'v.'): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith(prefix) ||
    !CALLBACK_PATTERN.test(value) ||
    value.length > 64
  ) {
    throw new Error('Prepared callback is invalid');
  }
  return value;
}

function safeDisplay(value: string, maximumLength: number): string {
  return (
    Array.from(value.replace(/\s+/g, ' '))
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      })
      .join('')
      .trim()
      .slice(0, maximumLength) || '—'
  );
}
