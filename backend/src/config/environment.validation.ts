import Joi from 'joi';

import {
  CONFIG_ENV_KEYS,
  type ApplicationLogLevel,
  type NodeEnvironment,
  type ValidatedEnvironment,
} from './configuration.types';

const DEVELOPMENT_VALUES = {
  DATABASE_URL:
    'postgresql://wc_telegram:development-only-postgres-password@postgres:5432/wc_telegram',
  REDIS_URL: 'redis://redis:6379',
  JWT_SECRET: 'development-only-jwt-secret-change-me',
  APP_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  BOT_INTERNAL_API_KEY: 'development-only-bot-internal-api-key',
  BOT_INTERNAL_URL: 'http://telegram-bot:3001',
  TELEGRAM_CALLBACK_SIGNING_KEY:
    'development-only-telegram-callback-signing-key',
  BACKEND_INTERNAL_URL: 'http://backend:3000/api',
  POSTGRES_PASSWORD: 'development-only-postgres-password',
} as const;

const TEST_VALUES = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/wc_telegram_test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-only-jwt-secret-not-for-production',
  APP_ENCRYPTION_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
  BOT_INTERNAL_API_KEY: 'test-only-bot-internal-api-key',
  BOT_INTERNAL_URL: 'http://localhost:3001',
  TELEGRAM_CALLBACK_SIGNING_KEY: 'test-only-telegram-callback-signing-key',
  BACKEND_INTERNAL_URL: 'http://localhost:3000/api',
} as const;

const NODE_ENVIRONMENTS: readonly NodeEnvironment[] = [
  'development',
  'test',
  'production',
];

const LOG_LEVELS: readonly ApplicationLogLevel[] = [
  'fatal',
  'error',
  'warn',
  'log',
  'debug',
  'verbose',
];

function determineEnvironment(
  environment: Record<string, unknown>
): NodeEnvironment {
  const value = environment['NODE_ENV'];

  return NODE_ENVIRONMENTS.includes(value as NodeEnvironment)
    ? (value as NodeEnvironment)
    : 'development';
}

function requiredOrTestDefault(
  schema: Joi.StringSchema,
  nodeEnvironment: NodeEnvironment,
  testDefault: string
): Joi.StringSchema {
  return nodeEnvironment === 'test'
    ? schema.default(testDefault)
    : schema.required();
}

function encryptionKeySchema(): Joi.StringSchema {
  return Joi.string()
    .trim()
    .custom((value: string, helpers: Joi.CustomHelpers) => {
      const decoded = Buffer.from(value, 'base64');

      if (decoded.length !== 32 || decoded.toString('base64') !== value) {
        return helpers.error('encryption.base64Length');
      }

      return value;
    });
}

function createEnvironmentSchema(
  nodeEnvironment: NodeEnvironment
): Joi.ObjectSchema {
  const isProduction = nodeEnvironment === 'production';
  const isTest = nodeEnvironment === 'test';

  let databaseUrl = requiredOrTestDefault(
    Joi.string()
      .trim()
      .uri({ scheme: ['postgres', 'postgresql'] }),
    nodeEnvironment,
    TEST_VALUES.DATABASE_URL
  );
  let redisUrl = Joi.string()
    .trim()
    .uri({ scheme: ['redis', 'rediss'] });
  let jwtSecret = requiredOrTestDefault(
    Joi.string().trim().min(32),
    nodeEnvironment,
    TEST_VALUES.JWT_SECRET
  );
  let encryptionKey = requiredOrTestDefault(
    encryptionKeySchema(),
    nodeEnvironment,
    TEST_VALUES.APP_ENCRYPTION_KEY
  );
  let botInternalApiKey = requiredOrTestDefault(
    Joi.string().trim().min(1),
    nodeEnvironment,
    TEST_VALUES.BOT_INTERNAL_API_KEY
  );
  let telegramCallbackSigningKey = requiredOrTestDefault(
    Joi.string().trim().min(32),
    nodeEnvironment,
    TEST_VALUES.TELEGRAM_CALLBACK_SIGNING_KEY
  );
  const backendInternalUrl = requiredOrTestDefault(
    Joi.string()
      .trim()
      .uri({ scheme: ['http', 'https'] }),
    nodeEnvironment,
    TEST_VALUES.BACKEND_INTERNAL_URL
  );
  const botInternalUrl = requiredOrTestDefault(
    Joi.string()
      .trim()
      .uri({ scheme: ['http', 'https'] }),
    nodeEnvironment,
    TEST_VALUES.BOT_INTERNAL_URL
  );
  let postgresPassword = Joi.string().trim().min(1).optional();

  if (isProduction) {
    databaseUrl = databaseUrl.invalid(
      DEVELOPMENT_VALUES.DATABASE_URL,
      TEST_VALUES.DATABASE_URL
    );
    redisUrl = redisUrl.required().invalid(TEST_VALUES.REDIS_URL);
    jwtSecret = jwtSecret.invalid(
      DEVELOPMENT_VALUES.JWT_SECRET,
      TEST_VALUES.JWT_SECRET
    );
    encryptionKey = encryptionKey.invalid(
      DEVELOPMENT_VALUES.APP_ENCRYPTION_KEY,
      TEST_VALUES.APP_ENCRYPTION_KEY
    );
    botInternalApiKey = botInternalApiKey
      .min(32)
      .invalid(
        DEVELOPMENT_VALUES.BOT_INTERNAL_API_KEY,
        TEST_VALUES.BOT_INTERNAL_API_KEY
      );
    telegramCallbackSigningKey = telegramCallbackSigningKey.invalid(
      DEVELOPMENT_VALUES.TELEGRAM_CALLBACK_SIGNING_KEY,
      TEST_VALUES.TELEGRAM_CALLBACK_SIGNING_KEY
    );
    postgresPassword = postgresPassword.invalid(
      DEVELOPMENT_VALUES.POSTGRES_PASSWORD
    );
  } else {
    redisUrl = redisUrl.default(
      isTest ? TEST_VALUES.REDIS_URL : DEVELOPMENT_VALUES.REDIS_URL
    );
  }

  return Joi.object({
    NODE_ENV: Joi.string()
      .valid(...NODE_ENVIRONMENTS)
      .default('development'),
    PORT: isProduction
      ? Joi.number().integer().min(1).max(65535).required()
      : Joi.number().integer().min(1).max(65535).default(3000),
    LOG_LEVEL: isProduction
      ? Joi.string().valid('fatal', 'error', 'warn', 'log').required()
      : Joi.string()
          .valid(...LOG_LEVELS)
          .default(isTest ? 'error' : 'debug'),
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    JWT_SECRET: jwtSecret,
    JWT_ACCESS_TTL: Joi.string().trim().min(1).required(),
    APP_ENCRYPTION_KEY: encryptionKey,
    BOT_INTERNAL_API_KEY: botInternalApiKey,
    BOT_INTERNAL_URL: botInternalUrl,
    BOT_INTERNAL_PORT: Joi.number().integer().min(1).max(65535).default(3001),
    BOT_DELIVERY_TIMEOUT_MS: Joi.number().integer().min(1).default(10000),
    BACKEND_INTERNAL_URL: backendInternalUrl,
    BOT_BACKEND_TIMEOUT_MS: Joi.number().integer().min(1).default(5000),
    BOT_STATUS_WRITE_TIMEOUT_MS: Joi.number().integer().min(1).default(50000),
    TELEGRAM_LINK_TOKEN_TTL_SECONDS: Joi.number().integer().min(1).default(900),
    TELEGRAM_CALLBACK_SIGNING_KEY: telegramCallbackSigningKey,
    TELEGRAM_CALLBACK_REF_TTL_SECONDS: Joi.number()
      .integer()
      .min(1)
      .default(900),
    TELEGRAM_ORDER_FRESHNESS_THRESHOLD_SECONDS: Joi.number()
      .integer()
      .min(1)
      .default(300),
    WOOCOMMERCE_REST_MAX_ATTEMPTS: Joi.number().integer().min(1).default(3),
    WOOCOMMERCE_REST_ATTEMPT_TIMEOUT_MS: Joi.number()
      .integer()
      .min(1)
      .default(5000),
    WOOCOMMERCE_REST_TOTAL_TIMEOUT_MS: Joi.number()
      .integer()
      .min(1)
      .default(15000),
    WOOCOMMERCE_REST_BACKOFF_BASE_MS: Joi.number()
      .integer()
      .min(0)
      .default(300),
    WOOCOMMERCE_REST_BACKOFF_FACTOR: Joi.number().min(1).default(2),
    WOOCOMMERCE_REST_JITTER_RATIO: Joi.number().min(0).max(1).default(0.2),
    PLUGIN_REGISTRATION_TOKEN_TTL_SECONDS: Joi.number()
      .integer()
      .min(1)
      .default(900),
    PLUGIN_REGISTRATION_RATE_LIMIT: Joi.number().integer().min(1).default(10),
    PLUGIN_REGISTRATION_RATE_WINDOW_SECONDS: Joi.number()
      .integer()
      .min(1)
      .default(60),
    AUTH_REGISTER_RATE_LIMIT: Joi.number().integer().min(1).default(5),
    AUTH_REGISTER_RATE_WINDOW_SECONDS: Joi.number()
      .integer()
      .min(1)
      .default(60),
    AUTH_LOGIN_RATE_LIMIT: Joi.number().integer().min(1).default(10),
    AUTH_LOGIN_RATE_WINDOW_SECONDS: Joi.number().integer().min(1).default(60),
    PILOT_MODE: isProduction
      ? Joi.boolean().truthy('true').falsy('false').valid(false).required()
      : Joi.boolean().truthy('true').falsy('false').default(false),
    PILOT_WEBHOOK_BASE_URL: Joi.string()
      .trim()
      .empty('')
      .uri({ scheme: ['https'] })
      .optional(),
    PILOT_READINESS_TIMEOUT_SECONDS: Joi.number()
      .integer()
      .min(1)
      .max(300)
      .default(60),
    POSTGRES_DB: Joi.string().trim().min(1).optional(),
    POSTGRES_USER: Joi.string().trim().min(1).optional(),
    POSTGRES_PASSWORD: postgresPassword,
    CADDY_DOMAIN: Joi.string()
      .trim()
      .uri({ scheme: ['http', 'https'] })
      .optional(),
  });
}

function describeValidationFailure(detail: Joi.ValidationErrorItem): string {
  const variable = String(detail.path[0] ?? 'configuration');

  switch (detail.type) {
    case 'any.required':
      return `${variable} is required`;
    case 'any.only':
      return `${variable} must use an allowed value`;
    case 'any.invalid':
      return `${variable} must not use a development placeholder in production`;
    case 'number.base':
      return `${variable} must be numeric`;
    case 'number.integer':
      return `${variable} must be an integer`;
    case 'number.min':
      return `${variable} must be at least ${String(detail.context?.['limit'])}`;
    case 'number.max':
      return `${variable} must be at most ${String(detail.context?.['limit'])}`;
    case 'string.empty':
      return `${variable} must not be empty`;
    case 'string.min':
      return `${variable} must contain at least ${String(detail.context?.['limit'])} characters`;
    case 'string.pattern.base':
      return `${variable} must match the Telegram bot token format`;
    case 'string.uri':
      return `${variable} must be a valid URL with an allowed scheme`;
    case 'encryption.base64Length':
      return `${variable} must be valid base64 encoding exactly 32 bytes`;
    default:
      return `${variable} does not satisfy rule ${detail.type}`;
  }
}

interface SecretBoundaryValue {
  name: string;
  boundary: string;
  value: string;
}

function urlPassword(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    const password = new URL(value).password;
    return password === '' ? undefined : password;
  } catch {
    return undefined;
  }
}

function secretBoundaryFailures(
  environment: Record<string, unknown>
): string[] {
  const candidates: SecretBoundaryValue[] = [
    {
      name: 'JWT_SECRET',
      boundary: 'jwt',
      value: String(environment['JWT_SECRET'] ?? ''),
    },
    {
      name: 'APP_ENCRYPTION_KEY',
      boundary: 'encryption',
      value: String(environment['APP_ENCRYPTION_KEY'] ?? ''),
    },
    {
      name: 'BOT_INTERNAL_API_KEY',
      boundary: 'backend-bot',
      value: String(environment['BOT_INTERNAL_API_KEY'] ?? ''),
    },
    {
      name: 'TELEGRAM_CALLBACK_SIGNING_KEY',
      boundary: 'telegram-callback',
      value: String(environment['TELEGRAM_CALLBACK_SIGNING_KEY'] ?? ''),
    },
    {
      name: 'DATABASE_URL password',
      boundary: 'postgresql',
      value: urlPassword(environment['DATABASE_URL']) ?? '',
    },
    {
      name: 'POSTGRES_PASSWORD',
      boundary: 'postgresql',
      value: String(environment['POSTGRES_PASSWORD'] ?? ''),
    },
    {
      name: 'REDIS_URL password',
      boundary: 'redis',
      value: urlPassword(environment['REDIS_URL']) ?? '',
    },
  ].filter((candidate) => candidate.value !== '');
  const failures = new Set<string>();

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < candidates.length;
      rightIndex += 1
    ) {
      const left = candidates[leftIndex]!;
      const right = candidates[rightIndex]!;

      if (left.boundary !== right.boundary && left.value === right.value) {
        failures.add(
          `${left.name} and ${right.name} must not reuse one secret across trust boundaries`
        );
      }
    }
  }

  return [...failures];
}

export class ConfigurationValidationError extends Error {
  constructor(failures: readonly string[]) {
    super(
      `Configuration validation failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`
    );
    this.name = 'ConfigurationValidationError';
  }
}

export function validateEnvironment(
  environment: Record<string, unknown>
): ValidatedEnvironment {
  const nodeEnvironment = determineEnvironment(environment);
  const { error, value } = createEnvironmentSchema(nodeEnvironment).validate(
    environment,
    {
      abortEarly: false,
      allowUnknown: true,
      convert: true,
    }
  );

  if (error) {
    const failures = [...new Set(error.details.map(describeValidationFailure))];
    throw new ConfigurationValidationError(failures);
  }

  if (nodeEnvironment === 'production') {
    const failures = secretBoundaryFailures(value);

    if (failures.length > 0) {
      throw new ConfigurationValidationError(failures);
    }
  }

  return Object.fromEntries(
    CONFIG_ENV_KEYS.filter((key) => value[key] !== undefined).map((key) => [
      key,
      value[key],
    ])
  ) as unknown as ValidatedEnvironment;
}
