import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { inspect } from 'node:util';

import {
  type ApplicationSettings,
  type EncryptionSettings,
  type JwtSettings,
  type PluginRegistrationSettings,
  type PostgreSqlSettings,
  type RedisSettings,
  type TelegramSettings,
  type ValidatedEnvironment,
  type WooCommerceSettings,
} from './configuration.types';
import { guardSecretSerialization, redactSecrets } from './secret-redaction';

@Injectable()
export class ApplicationConfigService {
  readonly app: Readonly<ApplicationSettings>;
  readonly postgres: Readonly<PostgreSqlSettings>;
  readonly redis: Readonly<RedisSettings>;
  readonly jwt: Readonly<JwtSettings>;
  readonly encryption: Readonly<EncryptionSettings>;
  readonly telegram: Readonly<TelegramSettings>;
  readonly woocommerce: Readonly<WooCommerceSettings>;
  readonly pluginRegistration: Readonly<PluginRegistrationSettings>;

  constructor(
    private readonly configService: ConfigService<ValidatedEnvironment, true>
  ) {
    this.app = Object.freeze({
      nodeEnv: this.configService.get('NODE_ENV', { infer: true }),
      port: this.configService.get('PORT', { infer: true }),
      logLevel: this.configService.get('LOG_LEVEL', { infer: true }),
    });
    this.postgres = guardSecretSerialization({
      url: this.configService.get('DATABASE_URL', { infer: true }),
    });
    this.redis = guardSecretSerialization({
      url: this.configService.get('REDIS_URL', { infer: true }),
    });
    this.jwt = guardSecretSerialization({
      secret: this.configService.get('JWT_SECRET', { infer: true }),
      accessTokenTtl: this.configService.get('JWT_ACCESS_TTL', { infer: true }),
    });
    this.encryption = guardSecretSerialization({
      key: this.configService.get('APP_ENCRYPTION_KEY', { infer: true }),
    });
    this.telegram = guardSecretSerialization({
      botToken: this.configService.get('TELEGRAM_BOT_TOKEN', { infer: true }),
      internalApiKey: this.configService.get('BOT_INTERNAL_API_KEY', {
        infer: true,
      }),
      backendInternalUrl: this.configService.get('BACKEND_INTERNAL_URL', {
        infer: true,
      }),
      linkTokenTtlSeconds: this.configService.get(
        'TELEGRAM_LINK_TOKEN_TTL_SECONDS',
        { infer: true }
      ),
    });
    this.woocommerce = guardSecretSerialization({
      webhookSecret: this.configService.get('WOOCOMMERCE_WEBHOOK_SECRET', {
        infer: true,
      }),
      rest: {
        maxAttempts: this.configService.get('WOOCOMMERCE_REST_MAX_ATTEMPTS', {
          infer: true,
        }),
        attemptTimeoutMs: this.configService.get(
          'WOOCOMMERCE_REST_ATTEMPT_TIMEOUT_MS',
          { infer: true }
        ),
        totalTimeoutMs: this.configService.get(
          'WOOCOMMERCE_REST_TOTAL_TIMEOUT_MS',
          { infer: true }
        ),
        backoffBaseMs: this.configService.get(
          'WOOCOMMERCE_REST_BACKOFF_BASE_MS',
          { infer: true }
        ),
        backoffFactor: this.configService.get(
          'WOOCOMMERCE_REST_BACKOFF_FACTOR',
          { infer: true }
        ),
        jitterRatio: this.configService.get('WOOCOMMERCE_REST_JITTER_RATIO', {
          infer: true,
        }),
      },
    });
    this.pluginRegistration = Object.freeze({
      tokenTtlSeconds: this.configService.get(
        'PLUGIN_REGISTRATION_TOKEN_TTL_SECONDS',
        { infer: true }
      ),
      rateLimit: this.configService.get('PLUGIN_REGISTRATION_RATE_LIMIT', {
        infer: true,
      }),
      rateWindowSeconds: this.configService.get(
        'PLUGIN_REGISTRATION_RATE_WINDOW_SECONDS',
        { infer: true }
      ),
    });
  }

  toJSON(): unknown {
    return redactSecrets({
      app: this.app,
      postgres: this.postgres,
      redis: this.redis,
      jwt: this.jwt,
      encryption: this.encryption,
      telegram: this.telegram,
      woocommerce: this.woocommerce,
      pluginRegistration: this.pluginRegistration,
    });
  }

  toString(): string {
    return JSON.stringify(this.toJSON());
  }

  [inspect.custom](): unknown {
    return this.toJSON();
  }
}
