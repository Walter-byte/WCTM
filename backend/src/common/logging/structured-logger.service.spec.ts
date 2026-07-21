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
        membershipRole: 'owner',
      });
      logger.log(
        'processing request',
        {
          password: 'password-value',
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
      membershipRole: 'owner',
      context: 'LoggerTest',
      message: 'processing request',
      metadata: {
        password: '****',
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
});

describe('RequestLoggingInterceptor', () => {
  it('emits structured request fields', () => {
    const logger = { log: jest.fn() } as unknown as StructuredLoggerService;
    const interceptor = new RequestLoggingInterceptor(logger);
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', originalUrl: '/api/health' }),
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
