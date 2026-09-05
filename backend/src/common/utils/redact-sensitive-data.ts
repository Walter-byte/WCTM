import { inspect } from 'node:util';

export const REDACTED_VALUE = '****';

const SENSITIVE_KEYS = new Set([
  'apikey',
  'authorization',
  'body',
  'cookie',
  'customer',
  'email',
  'databaseurl',
  'encryptionkey',
  'headers',
  'key',
  'note',
  'notebody',
  'password',
  'passwordhash',
  'payload',
  'phone',
  'privatekey',
  'query',
  'rawbody',
  'rawwebhookbody',
  'redisurl',
  'searchquery',
  'secret',
  'signature',
  'telegramupdate',
  'token',
  'update',
  'url',
]);

const SENSITIVE_TEXT_PATTERN =
  /((?:api[_ -]?key|authorization|credentials?|encryption[_ -]?key|password[_ -]?hash|password|secret|signature|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER_TOKEN_PATTERN = /\b(Bearer)\s+[^\s,;]+/gi;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');

  return (
    SENSITIVE_KEYS.has(normalized) ||
    normalized.endsWith('credential') ||
    normalized.endsWith('credentials') ||
    normalized.endsWith('key') ||
    normalized.endsWith('passwordhash') ||
    normalized.endsWith('password') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('signature') ||
    normalized.endsWith('token') ||
    normalized.endsWith('body') ||
    normalized.endsWith('query') ||
    normalized.endsWith('payload') ||
    normalized.endsWith('update') ||
    normalized.endsWith('email') ||
    normalized.endsWith('phone')
  );
}

function redactKnownValues(
  value: string,
  sensitiveValues: readonly string[]
): string {
  return [...new Set(sensitiveValues)]
    .filter((secret) => secret.length >= 8)
    .sort((left, right) => right.length - left.length)
    .reduce(
      (redacted, secret) => redacted.split(secret).join(REDACTED_VALUE),
      value
    );
}

export function redactSensitiveText(
  value: string,
  sensitiveValues: readonly string[] = []
): string {
  return redactKnownValues(value, sensitiveValues)
    .replace(BEARER_TOKEN_PATTERN, '$1 ****')
    .replace(SENSITIVE_TEXT_PATTERN, `$1${REDACTED_VALUE}`);
}

function redactValue(
  value: unknown,
  seen: WeakSet<object>,
  sensitiveValues: readonly string[]
): unknown {
  if (typeof value === 'string') {
    return redactSensitiveText(value, sensitiveValues);
  }

  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveText(value.message, sensitiveValues),
      stack: value.stack
        ? redactSensitiveText(value.stack, sensitiveValues)
        : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, seen, sensitiveValues));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveKey(key)
        ? REDACTED_VALUE
        : redactValue(entry, seen, sensitiveValues),
    ])
  );
}

export function redactSensitiveData(
  value: unknown,
  sensitiveValues: readonly string[] = []
): unknown {
  return redactValue(value, new WeakSet<object>(), sensitiveValues);
}

export function guardSensitiveSerialization<T extends object>(value: T): T {
  Object.defineProperties(value, {
    toJSON: {
      enumerable: false,
      value: () => redactSensitiveData(value),
    },
    toString: {
      enumerable: false,
      value: () => JSON.stringify(redactSensitiveData(value)),
    },
    [inspect.custom]: {
      enumerable: false,
      value: () => redactSensitiveData(value),
    },
  });

  return Object.freeze(value);
}
