import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { inspect } from 'node:util';

import {
  type ApplicationSettings,
  type EncryptionSettings,
  type JwtSettings,
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
    });
    this.encryption = guardSecretSerialization({
      key: this.configService.get('APP_ENCRYPTION_KEY', { infer: true }),
    });
    this.telegram = guardSecretSerialization({
      botToken: this.configService.get('TELEGRAM_BOT_TOKEN', { infer: true }),
    });
    this.woocommerce = guardSecretSerialization({
      webhookSecret: this.configService.get('WOOCOMMERCE_WEBHOOK_SECRET', {
        infer: true,
      }),
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
    });
  }

  toString(): string {
    return JSON.stringify(this.toJSON());
  }

  [inspect.custom](): unknown {
    return this.toJSON();
  }
}
