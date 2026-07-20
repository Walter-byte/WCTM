import { inspect } from 'node:util';

export const REDACTED_VALUE = '****';

const SECRET_KEYS = new Set([
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'APP_ENCRYPTION_KEY',
  'TELEGRAM_BOT_TOKEN',
  'WOOCOMMERCE_WEBHOOK_SECRET',
  'POSTGRES_PASSWORD',
  'url',
  'secret',
  'key',
  'botToken',
  'webhookSecret',
]);

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SECRET_KEYS.has(key) ? REDACTED_VALUE : redactSecrets(entry),
    ])
  );
}

export function guardSecretSerialization<T extends object>(value: T): T {
  Object.defineProperties(value, {
    toJSON: {
      enumerable: false,
      value: () => redactSecrets(value),
    },
    toString: {
      enumerable: false,
      value: () => JSON.stringify(redactSecrets(value)),
    },
    [inspect.custom]: {
      enumerable: false,
      value: () => redactSecrets(value),
    },
  });

  return Object.freeze(value);
}
