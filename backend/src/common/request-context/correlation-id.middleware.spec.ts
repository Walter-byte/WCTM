import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { ApplicationConfigService } from '../../config/application-config.service';
import { StructuredLoggerService } from '../logging/structured-logger.service';
import {
  CORRELATION_ID_HEADER,
  CorrelationIdMiddleware,
  REQUEST_ID_HEADER,
  TELEGRAM_UPDATE_ID_HEADER,
} from './correlation-id.middleware';
import { RequestContextService } from './request-context.service';

function configuration(): ApplicationConfigService {
  return {
    app: { logLevel: 'log' },
  } as ApplicationConfigService;
}

describe('CorrelationIdMiddleware', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('generates a request ID and makes it available to response headers and logs', () => {
    const requestContext = new RequestContextService();
    const middleware = new CorrelationIdMiddleware(requestContext);
    const logger = new StructuredLoggerService(configuration(), requestContext);
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const request: {
      headers: Record<string, string | string[] | undefined>;
      requestId?: string;
    } = { headers: {} };
    const response = { setHeader: jest.fn() };

    middleware.use(request, response, () => {
      logger.log('request log', 'CorrelationTest');
    });

    expect(request.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      REQUEST_ID_HEADER,
      request.requestId
    );

    const record = JSON.parse(String(write.mock.calls[0]?.[0])) as {
      requestId: string;
    };
    expect(record.requestId).toBe(request.requestId);
  });

  it('preserves a provided request ID', () => {
    const requestContext = new RequestContextService();
    const middleware = new CorrelationIdMiddleware(requestContext);
    const request = {
      headers: { [REQUEST_ID_HEADER]: 'client-request-id' },
    };
    const response = { setHeader: jest.fn() };
    let observedRequestId: string | undefined;

    middleware.use(request, response, () => {
      observedRequestId = requestContext.requestId;
    });

    expect(observedRequestId).toBe('client-request-id');
    expect(response.setHeader).toHaveBeenCalledWith(
      REQUEST_ID_HEADER,
      'client-request-id'
    );
  });

  it('propagates internal correlation and Telegram update IDs into structured logs', () => {
    const requestContext = new RequestContextService();
    const middleware = new CorrelationIdMiddleware(requestContext);
    const logger = new StructuredLoggerService(configuration(), requestContext);
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const request = {
      headers: {
        [CORRELATION_ID_HEADER]: 'bot-correlation-id',
        [TELEGRAM_UPDATE_ID_HEADER]: '123456',
      },
    };
    const response = { setHeader: jest.fn() };

    middleware.use(request, response, () => {
      logger.log('internal request', 'TelegramInternal');
    });

    const record = JSON.parse(String(write.mock.calls[0]?.[0])) as {
      requestId: string;
      telegramUpdateId: string;
    };
    expect(record).toMatchObject({
      requestId: 'bot-correlation-id',
      telegramUpdateId: '123456',
    });
    expect(response.setHeader).toHaveBeenCalledWith(
      CORRELATION_ID_HEADER,
      'bot-correlation-id'
    );
  });
});
