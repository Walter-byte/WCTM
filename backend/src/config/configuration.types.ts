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
  APP_ENCRYPTION_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  WOOCOMMERCE_WEBHOOK_SECRET: string;
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
  'APP_ENCRYPTION_KEY',
  'TELEGRAM_BOT_TOKEN',
  'WOOCOMMERCE_WEBHOOK_SECRET',
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
}

export interface EncryptionSettings {
  key: string;
}

export interface TelegramSettings {
  botToken: string;
}

export interface WooCommerceSettings {
  webhookSecret: string;
}
