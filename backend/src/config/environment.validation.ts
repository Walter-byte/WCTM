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
  WOOCOMMERCE_WEBHOOK_SECRET: 'development-only-webhook-secret-change-me',
  POSTGRES_PASSWORD: 'development-only-postgres-password',
} as const;

const TEST_VALUES = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/wc_telegram_test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-only-jwt-secret-not-for-production',
  APP_ENCRYPTION_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
  TELEGRAM_BOT_TOKEN: '0000000000:test-placeholder-token-value',
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
    WOOCOMMERCE_WEBHOOK_SECRET: webhookSecret,
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
    case 'number.max':
      return `${variable} must be between 1 and 65535`;
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
