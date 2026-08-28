import { describe, expect, it, jest } from '@jest/globals';
import {
  type ArgumentsHost,
  BadRequestException,
  HttpStatus,
} from '@nestjs/common';

import type { StructuredLoggerService } from '../logging/structured-logger.service';
import { RequestContextService } from '../request-context/request-context.service';
import { GlobalExceptionFilter } from './global-exception.filter';

interface CapturedResponse {
  status: jest.Mock;
  json: jest.Mock;
}

function hostFor(response: CapturedResponse): ArgumentsHost {
  return {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
}

function loggerMock(): StructuredLoggerService {
  return {
    error: jest.fn(),
    warn: jest.fn(),
  } as unknown as StructuredLoggerService;
}

function responseMock(): CapturedResponse {
  const response = {
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

describe('GlobalExceptionFilter', () => {
  it('preserves HttpException semantics in the normalized secret-safe contract', () => {
    const requestContext = new RequestContextService();
    const logger = loggerMock();
    const filter = new GlobalExceptionFilter(requestContext, logger);
    const response = responseMock();

    requestContext.run('req-http-error', () => {
      filter.catch(
        new BadRequestException({
          error: 'Bad Request',
          message:
            'Invalid token=raw-token password=raw-password password_hash=raw-hash',
          credentials: 'raw-credentials',
        }),
        hostFor(response)
      );
    });

    expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      message: 'Invalid token=**** password=**** password_hash=****',
      requestId: 'req-http-error',
    });
    expect(JSON.stringify(response.json.mock.calls)).not.toContain('raw-token');
    expect(JSON.stringify(response.json.mock.calls)).not.toContain(
      'raw-password'
    );
    expect(JSON.stringify(response.json.mock.calls)).not.toContain('raw-hash');
    expect(JSON.stringify(response.json.mock.calls)).not.toContain(
      'raw-credentials'
    );
    expect(logger.warn).toHaveBeenCalled();
  });

  it('maps unknown errors to a generic 500 response without internal details', () => {
    const requestContext = new RequestContextService();
    const logger = loggerMock();
    const filter = new GlobalExceptionFilter(requestContext, logger);
    const response = responseMock();

    requestContext.run('req-unknown-error', () => {
      filter.catch(
        new Error('Database password=raw-password failed'),
        hostFor(response)
      );
    });

    expect(response.status).toHaveBeenCalledWith(
      HttpStatus.INTERNAL_SERVER_ERROR
    );
    expect(response.json).toHaveBeenCalledWith({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: 'Internal server error',
      requestId: 'req-unknown-error',
    });
    expect(JSON.stringify(response.json.mock.calls)).not.toContain(
      'raw-password'
    );
    expect(logger.error).toHaveBeenCalled();
  });
});
