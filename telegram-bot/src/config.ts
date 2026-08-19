import Joi from 'joi';

export interface BotConfiguration {
  botToken: string;
  internalApiKey: string;
  backendInternalUrl: string;
  backendTimeoutMs: number;
  statusWriteTimeoutMs: number;
}

const botEnvironmentSchema = Joi.object({
  TELEGRAM_BOT_TOKEN: Joi.string()
    .pattern(/^\d+:[A-Za-z0-9_-]{20,}$/)
    .required(),
  BOT_INTERNAL_API_KEY: Joi.string().trim().min(1).required(),
  BACKEND_INTERNAL_URL: Joi.string()
    .trim()
    .uri({ scheme: ['http', 'https'] })
    .required(),
  BOT_BACKEND_TIMEOUT_MS: Joi.number().integer().min(1).default(5000),
  BOT_STATUS_WRITE_TIMEOUT_MS: Joi.number().integer().min(1).default(50000),
}).unknown(true);

export function loadBotConfiguration(
  environment: NodeJS.ProcessEnv
): BotConfiguration {
  const { error, value } = botEnvironmentSchema.validate(environment, {
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
    backendInternalUrl: String(value.BACKEND_INTERNAL_URL).replace(/\/+$/, ''),
    backendTimeoutMs: Number(value.BOT_BACKEND_TIMEOUT_MS),
    statusWriteTimeoutMs: Number(value.BOT_STATUS_WRITE_TIMEOUT_MS),
  });
}
