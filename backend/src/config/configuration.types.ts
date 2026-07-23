export type NodeEnvironment = 'development' | 'test' | 'production';

export type ApplicationLogLevel =
  'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose';

export interface ValidatedEnvironment {
  NODE_ENV: NodeEnvironment;
  PORT: number;
  LOG_LEVEL: ApplicationLogLevel;
  DATABASE_URL: string;
  REDIS_URL: string;
  JWT_SECRET: string;
  JWT_ACCESS_TTL: string;
  APP_ENCRYPTION_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  BOT_INTERNAL_API_KEY: string;
  BACKEND_INTERNAL_URL: string;
  TELEGRAM_LINK_TOKEN_TTL_SECONDS: number;
  WOOCOMMERCE_WEBHOOK_SECRET: string;
  WOOCOMMERCE_REST_MAX_ATTEMPTS: number;
  WOOCOMMERCE_REST_ATTEMPT_TIMEOUT_MS: number;
  WOOCOMMERCE_REST_TOTAL_TIMEOUT_MS: number;
  WOOCOMMERCE_REST_BACKOFF_BASE_MS: number;
  WOOCOMMERCE_REST_BACKOFF_FACTOR: number;
  WOOCOMMERCE_REST_JITTER_RATIO: number;
  PLUGIN_REGISTRATION_TOKEN_TTL_SECONDS: number;
  PLUGIN_REGISTRATION_RATE_LIMIT: number;
  PLUGIN_REGISTRATION_RATE_WINDOW_SECONDS: number;
  POSTGRES_DB?: string;
  POSTGRES_USER?: string;
  POSTGRES_PASSWORD?: string;
  CADDY_DOMAIN?: string;
}

export const CONFIG_ENV_KEYS = [
  'NODE_ENV',
  'PORT',
  'LOG_LEVEL',
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'JWT_ACCESS_TTL',
  'APP_ENCRYPTION_KEY',
  'TELEGRAM_BOT_TOKEN',
  'BOT_INTERNAL_API_KEY',
  'BACKEND_INTERNAL_URL',
  'TELEGRAM_LINK_TOKEN_TTL_SECONDS',
  'WOOCOMMERCE_WEBHOOK_SECRET',
  'WOOCOMMERCE_REST_MAX_ATTEMPTS',
  'WOOCOMMERCE_REST_ATTEMPT_TIMEOUT_MS',
  'WOOCOMMERCE_REST_TOTAL_TIMEOUT_MS',
  'WOOCOMMERCE_REST_BACKOFF_BASE_MS',
  'WOOCOMMERCE_REST_BACKOFF_FACTOR',
  'WOOCOMMERCE_REST_JITTER_RATIO',
  'PLUGIN_REGISTRATION_TOKEN_TTL_SECONDS',
  'PLUGIN_REGISTRATION_RATE_LIMIT',
  'PLUGIN_REGISTRATION_RATE_WINDOW_SECONDS',
  'POSTGRES_DB',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'CADDY_DOMAIN',
] as const satisfies readonly (keyof ValidatedEnvironment)[];

export interface ApplicationSettings {
  nodeEnv: NodeEnvironment;
  port: number;
  logLevel: ApplicationLogLevel;
}

export interface PostgreSqlSettings {
  url: string;
}

export interface RedisSettings {
  url: string;
}

export interface JwtSettings {
  secret: string;
  accessTokenTtl: string;
}

export interface EncryptionSettings {
  key: string;
}

export interface TelegramSettings {
  botToken: string;
  internalApiKey: string;
  backendInternalUrl: string;
  linkTokenTtlSeconds: number;
}

export interface WooCommerceSettings {
  webhookSecret: string;
  rest: WooCommerceRestSettings;
}

export interface WooCommerceRestSettings {
  maxAttempts: number;
  attemptTimeoutMs: number;
  totalTimeoutMs: number;
  backoffBaseMs: number;
  backoffFactor: number;
  jitterRatio: number;
}

export interface PluginRegistrationSettings {
  tokenTtlSeconds: number;
  rateLimit: number;
  rateWindowSeconds: number;
}
