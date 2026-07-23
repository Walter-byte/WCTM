import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { RequestContextService } from './request-context.service';

export const REQUEST_ID_HEADER = 'x-request-id';
export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const TELEGRAM_UPDATE_ID_HEADER = 'x-telegram-update-id';

interface RequestWithContext {
  headers: Record<string, string | string[] | undefined>;
  requestId?: string;
}

interface ResponseWithHeaders {
  setHeader(name: string, value: string): void;
}

@Injectable()
export class CorrelationIdMiddleware {
  constructor(private readonly requestContext: RequestContextService) {}

  use(
    request: RequestWithContext,
    response: ResponseWithHeaders,
    next: () => void
  ): void {
    const inboundHeader = request.headers[REQUEST_ID_HEADER];
    const correlationHeader = request.headers[CORRELATION_ID_HEADER];
    const inboundCorrelationId = Array.isArray(correlationHeader)
      ? correlationHeader[0]
      : correlationHeader;
    const inboundRequestId = Array.isArray(inboundHeader)
      ? inboundHeader[0]
      : inboundHeader;
    const updateHeader = request.headers[TELEGRAM_UPDATE_ID_HEADER];
    const telegramUpdateId = (
      Array.isArray(updateHeader) ? updateHeader[0] : updateHeader
    )?.trim();
    const requestId =
      inboundCorrelationId?.trim() || inboundRequestId?.trim() || randomUUID();

    request.requestId = requestId;
    response.setHeader(REQUEST_ID_HEADER, requestId);
    response.setHeader(CORRELATION_ID_HEADER, requestId);
    this.requestContext.run(requestId, next, telegramUpdateId);
  }
}
