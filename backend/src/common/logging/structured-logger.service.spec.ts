import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';

import type { ApplicationConfigService } from '../../config/application-config.service';
import { RequestContextService } from '../request-context/request-context.service';
import { RequestLoggingInterceptor } from './request-logging.interceptor';
import { StructuredLoggerService } from './structured-logger.service';

function configuration(
  logLevel: 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose'
): ApplicationConfigService {
  return {
    app: { logLevel },
  } as ApplicationConfigService;
}

function configurationWithSentinels(): ApplicationConfigService {
  return {
    app: { logLevel: 'log' },
    postgres: {
      url: 'postgresql://runtime:database-sentinel@postgres:5432/app',
    },
    redis: { url: 'redis://:redis-sentinel@redis:6379' },
    jwt: { secret: 'jwt-secret-sentinel-12345678901234567890' },
    encryption: {
      key: 'ZW5jcnlwdGlvbi1rZXktc2VudGluZWwtMzItYnl0ZXM=',
    },
    telegram: {
      internalApiKey: 'bot-internal-sentinel-123456789012345',
      callbackSigningKey: 'callback-sentinel-12345678901234567890',
    },
  } as ApplicationConfigService;
}

describe('StructuredLoggerService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('emits structured JSON with request context and redacted fields', () => {
    const requestContext = new RequestContextService();
    const logger = new StructuredLoggerService(
      configuration('log'),
      requestContext
    );
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    requestContext.run('req-structured', () => {
      requestContext.setTenant({
        tenantId: 'ten_logger',
        userId: 'usr_logger',
        membershipRole: 'OWNER',
      });
      logger.log(
        'processing request',
        {
          password: 'password-value',
          passwordHash: 'argon-hash-value',
          nested: {
            accessToken: 'token-value',
            credentials: 'credential-value',
            encryptionKey: 'encryption-value',
          },
          safe: 'visible',
        },
        'LoggerTest'
      );
    });

    const output = String(write.mock.calls[0]?.[0]);
    const record = JSON.parse(output) as {
      level: string;
      requestId: string;
      tenantId: string;
      userId: string;
      membershipRole: string;
      context: string;
      message: string;
      metadata: Record<string, unknown>;
    };

    expect(record).toMatchObject({
      level: 'log',
      requestId: 'req-structured',
      tenantId: 'ten_logger',
      userId: 'usr_logger',
      membershipRole: 'OWNER',
      context: 'LoggerTest',
      message: 'processing request',
      metadata: {
        password: '****',
        passwordHash: '****',
        safe: 'visible',
        nested: {
          accessToken: '****',
          credentials: '****',
          encryptionKey: '****',
        },
      },
    });
    expect(record).toHaveProperty('timestamp');
    expect(output).not.toContain('password-value');
    expect(output).not.toContain('argon-hash-value');
    expect(output).not.toContain('token-value');
    expect(output).not.toContain('credential-value');
    expect(output).not.toContain('encryption-value');
  });

  it('honors the configured log level', () => {
    const logger = new StructuredLoggerService(
      configuration('warn'),
      new RequestContextService()
    );
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    logger.log('suppressed');
    logger.debug('suppressed');
    logger.warn('emitted');

    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain('"level":"warn"');
  });

  it('redacts configured sentinel secrets even inside unlabelled text', () => {
    const configuration = configurationWithSentinels();
    const logger = new StructuredLoggerService(
      configuration,
      new RequestContextService()
    );
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const sentinels = [
      configuration.postgres.url,
      configuration.redis.url,
      configuration.jwt.secret,
      configuration.encryption.key,
      configuration.telegram.internalApiKey,
      configuration.telegram.callbackSigningKey,
    ];

    logger.log(`unlabelled ${sentinels.join(' ')}`, {
      rawBody: 'raw-webhook-sentinel',
      searchQuery: 'customer-search-sentinel',
      noteBody: 'note-body-sentinel',
      webhookSignature: 'webhook-signature-sentinel',
    });

    const output = String(write.mock.calls[0]?.[0]);
    for (const sentinel of [
      ...sentinels,
      'raw-webhook-sentinel',
      'customer-search-sentinel',
      'note-body-sentinel',
      'webhook-signature-sentinel',
    ]) {
      expect(output).not.toContain(sentinel);
    }
    expect(output).toContain('****');
  });
});

describe('RequestLoggingInterceptor', () => {
  it('emits structured request fields without query or fragment data', () => {
    const logger = { log: jest.fn() } as unknown as StructuredLoggerService;
    const interceptor = new RequestLoggingInterceptor(logger);
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          originalUrl: '/api/health?token=query-secret#fragment-secret',
        }),
      }),
    } as unknown as ExecutionContext;
    const result = of({ status: 'ok' });
    const next = { handle: () => result } as CallHandler;

    expect(interceptor.intercept(context, next)).toBe(result);
    expect(logger.log).toHaveBeenCalledWith(
      'HTTP request received',
      { method: 'GET', path: '/api/health' },
      RequestLoggingInterceptor.name
    );
  });
});
