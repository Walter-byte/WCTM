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
  TELEGRAM_BOT_TOKEN: '0000000000:development-placeholder-token',
  BOT_INTERNAL_API_KEY: 'development-only-bot-internal-api-key',
  BOT_INTERNAL_URL: 'http://telegram-bot:3001',
  TELEGRAM_CALLBACK_SIGNING_KEY:
    'development-only-telegram-callback-signing-key',
  BACKEND_INTERNAL_URL: 'http://backend:3000/api',
  WOOCOMMERCE_WEBHOOK_SECRET: 'development-only-webhook-secret-change-me',
  POSTGRES_PASSWORD: 'development-only-postgres-password',
} as const;

const TEST_VALUES = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/wc_telegram_test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-only-jwt-secret-not-for-production',
  APP_ENCRYPTION_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
  TELEGRAM_BOT_TOKEN: '0000000000:test-placeholder-token-value',
  BOT_INTERNAL_API_KEY: 'test-only-bot-internal-api-key',
  BOT_INTERNAL_URL: 'http://localhost:3001',
  TELEGRAM_CALLBACK_SIGNING_KEY: 'test-only-telegram-callback-signing-key',
  BACKEND_INTERNAL_URL: 'http://localhost:3000/api',
  WOOCOMMERCE_WEBHOOK_SECRET: 'test-only-webhook-secret-not-for-production',
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
  let telegramBotToken = requiredOrTestDefault(
    Joi.string().pattern(/^\d+:[A-Za-z0-9_-]{20,}$/),
    nodeEnvironment,
    TEST_VALUES.TELEGRAM_BOT_TOKEN
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
  let webhookSecret = requiredOrTestDefault(
    Joi.string().trim().min(32),
    nodeEnvironment,
    TEST_VALUES.WOOCOMMERCE_WEBHOOK_SECRET
  );
  let postgresPassword = Joi.string().trim().min(1).optional();

  if (isProduction) {
    databaseUrl = databaseUrl.invalid(DEVELOPMENT_VALUES.DATABASE_URL);
    redisUrl = redisUrl.required();
    jwtSecret = jwtSecret.invalid(DEVELOPMENT_VALUES.JWT_SECRET);
    encryptionKey = encryptionKey.invalid(
      DEVELOPMENT_VALUES.APP_ENCRYPTION_KEY
    );
    telegramBotToken = telegramBotToken.invalid(
      DEVELOPMENT_VALUES.TELEGRAM_BOT_TOKEN
    );
    botInternalApiKey = botInternalApiKey.invalid(
      DEVELOPMENT_VALUES.BOT_INTERNAL_API_KEY
    );
    telegramCallbackSigningKey = telegramCallbackSigningKey.invalid(
      DEVELOPMENT_VALUES.TELEGRAM_CALLBACK_SIGNING_KEY
    );
    webhookSecret = webhookSecret.invalid(
      DEVELOPMENT_VALUES.WOOCOMMERCE_WEBHOOK_SECRET
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
      ? Joi.string()
          .valid(...LOG_LEVELS)
          .required()
      : Joi.string()
          .valid(...LOG_LEVELS)
          .default(isTest ? 'error' : 'debug'),
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    JWT_SECRET: jwtSecret,
    JWT_ACCESS_TTL: Joi.string().trim().min(1).required(),
    APP_ENCRYPTION_KEY: encryptionKey,
    TELEGRAM_BOT_TOKEN: telegramBotToken,
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
    WOOCOMMERCE_WEBHOOK_SECRET: webhookSecret,
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
    PILOT_MODE: Joi.boolean().truthy('true').falsy('false').default(false),
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

  return Object.fromEntries(
    CONFIG_ENV_KEYS.filter((key) => value[key] !== undefined).map((key) => [
      key,
      value[key],
    ])
  ) as unknown as ValidatedEnvironment;
}
