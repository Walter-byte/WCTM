import { GrammyError, HttpError, InlineKeyboard, type Api } from 'grammy';
import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import type { BotConfiguration } from './config';

const MAX_BODY_BYTES = 16 * 1024;
const CALLBACK_PATTERN =
  /^(?:d\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}|t:d\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16})$/;

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
    const keyboard = new InlineKeyboard();

    for (const button of input.buttons) {
      keyboard.text(button.text, button.callbackData);
    }

    try {
      const message = await this.api.sendMessage(input.chatId, input.text, {
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
  const buttons = record['buttons'];

  if (
    typeof record['chatId'] !== 'string' ||
    !/^-?[1-9]\d{0,18}$/.test(record['chatId']) ||
    typeof record['text'] !== 'string' ||
    record['text'].length < 1 ||
    record['text'].length > 4096 ||
    !Array.isArray(buttons) ||
    buttons.length < 1 ||
    buttons.length > 2
  ) {
    throw new Error('Prepared message is invalid');
  }

  const validatedButtons = buttons.map((button) => {
    if (
      button === null ||
      typeof button !== 'object' ||
      Array.isArray(button)
    ) {
      throw new Error('Prepared button is invalid');
    }

    const candidate = button as Record<string, unknown>;

    if (
      typeof candidate['text'] !== 'string' ||
      candidate['text'].length < 1 ||
      candidate['text'].length > 64 ||
      typeof candidate['callbackData'] !== 'string' ||
      !CALLBACK_PATTERN.test(candidate['callbackData']) ||
      candidate['callbackData'].length > 64
    ) {
      throw new Error('Prepared button is invalid');
    }

    return {
      text: candidate['text'],
      callbackData: candidate['callbackData'],
    };
  });

  return {
    chatId: record['chatId'],
    text: record['text'],
    buttons: validatedButtons,
  };
}
