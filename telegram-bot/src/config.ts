import Joi from 'joi';

export interface BotConfiguration {
  botToken: string;
  internalApiKey: string;
  internalPort: number;
  backendInternalUrl: string;
  backendTimeoutMs: number;
  statusWriteTimeoutMs: number;
}

const PRODUCTION_PLACEHOLDERS = {
  TELEGRAM_BOT_TOKEN: [
    '0000000000:development-placeholder-token',
    '0000000000:test-placeholder-token-value',
  ],
  BOT_INTERNAL_API_KEY: [
    'development-only-bot-internal-api-key',
    'test-only-bot-internal-api-key',
  ],
} as const;

function createBotEnvironmentSchema(isProduction: boolean): Joi.ObjectSchema {
  let botToken = Joi.string()
    .pattern(/^\d+:[A-Za-z0-9_-]{20,}$/)
    .required();
  let internalApiKey = Joi.string().trim().min(1).required();

  if (isProduction) {
    botToken = botToken.invalid(...PRODUCTION_PLACEHOLDERS.TELEGRAM_BOT_TOKEN);
    internalApiKey = internalApiKey
      .min(32)
      .invalid(...PRODUCTION_PLACEHOLDERS.BOT_INTERNAL_API_KEY);
  }

  return Joi.object({
    NODE_ENV: Joi.string()
      .valid('development', 'test', 'production')
      .default('development'),
    TELEGRAM_BOT_TOKEN: botToken,
    BOT_INTERNAL_API_KEY: internalApiKey,
    BOT_INTERNAL_PORT: Joi.number().integer().min(1).max(65535).default(3001),
    BACKEND_INTERNAL_URL: Joi.string()
      .trim()
      .uri({ scheme: ['http', 'https'] })
      .required(),
    BOT_BACKEND_TIMEOUT_MS: Joi.number().integer().min(1).default(5000),
    BOT_STATUS_WRITE_TIMEOUT_MS: Joi.number().integer().min(1).default(50000),
  }).unknown(true);
}

export function loadBotConfiguration(
  environment: NodeJS.ProcessEnv
): BotConfiguration {
  const { error, value } = createBotEnvironmentSchema(
    environment.NODE_ENV === 'production'
  ).validate(environment, {
    abortEarly: false,
    convert: true,
  });

  if (error) {
    const names = [
      ...new Set(error.details.map((detail) => String(detail.path[0]))),
    ];
    throw new Error(`Bot configuration is invalid: ${names.join(', ')}`);
  }

  return Object.freeze({
    botToken: String(value.TELEGRAM_BOT_TOKEN),
    internalApiKey: String(value.BOT_INTERNAL_API_KEY),
    internalPort: Number(value.BOT_INTERNAL_PORT),
    backendInternalUrl: String(value.BACKEND_INTERNAL_URL).replace(/\/+$/, ''),
    backendTimeoutMs: Number(value.BOT_BACKEND_TIMEOUT_MS),
    statusWriteTimeoutMs: Number(value.BOT_STATUS_WRITE_TIMEOUT_MS),
  });
}
