import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

import { StructuredLoggerService } from '../logging/structured-logger.service';
import { RequestContextService } from '../request-context/request-context.service';
import { redactSensitiveData } from '../utils/redact-sensitive-data';

interface ErrorResponse {
  statusCode: number;
  error: string;
  message: string | string[];
  requestId: string;
  code?: 'ENTITLEMENT_INACTIVE';
  effectiveState?: 'SUSPENDED' | 'EXPIRED';
}

interface HttpResponseAdapter {
  status(statusCode: number): HttpResponseAdapter;
  json(body: ErrorResponse): unknown;
}

function statusLabel(statusCode: number): string {
  const statusName = HttpStatus[statusCode];

  if (typeof statusName !== 'string') {
    return 'Error';
  }

  return statusName
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function safeMessage(value: unknown, fallback: string): string | string[] {
  if (typeof value === 'string') {
    return String(redactSensitiveData(value));
  }

  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string')
  ) {
    return value.map((entry) => String(redactSensitiveData(entry)));
  }

  return String(redactSensitiveData(fallback));
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly requestContext: RequestContextService,
    private readonly logger: StructuredLoggerService
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponseAdapter>();
    const isHttpException = exception instanceof HttpException;
    const statusCode = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const defaultError = statusLabel(statusCode);
    const defaultMessage = isHttpException
      ? exception.message
      : 'Internal server error';
    const exceptionResponse = isHttpException
      ? exception.getResponse()
      : undefined;
    const responseObject =
      exceptionResponse !== null && typeof exceptionResponse === 'object'
        ? (exceptionResponse as Record<string, unknown>)
        : undefined;
    const error =
      typeof responseObject?.['error'] === 'string'
        ? String(redactSensitiveData(responseObject['error']))
        : defaultError;
    const message = safeMessage(
      responseObject?.['message'] ?? exceptionResponse,
      defaultMessage
    );
    const requestId = this.requestContext.requestId ?? 'unknown';
    const body: ErrorResponse = {
      statusCode,
      error,
      message,
      requestId,
      ...(responseObject?.['code'] === 'ENTITLEMENT_INACTIVE'
        ? {
            code: 'ENTITLEMENT_INACTIVE',
            ...(responseObject['effectiveState'] === 'SUSPENDED' ||
            responseObject['effectiveState'] === 'EXPIRED'
              ? { effectiveState: responseObject['effectiveState'] }
              : {}),
          }
        : {}),
    };
    const logMetadata = { statusCode, error };

    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        'HTTP request failed',
        logMetadata,
        GlobalExceptionFilter.name
      );
    } else {
      this.logger.warn(
        'HTTP request failed',
        logMetadata,
        GlobalExceptionFilter.name
      );
    }

    response.status(statusCode).json(body);
  }
}
