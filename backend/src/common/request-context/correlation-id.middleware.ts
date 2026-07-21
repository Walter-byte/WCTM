import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { RequestContextService } from './request-context.service';

export const REQUEST_ID_HEADER = 'x-request-id';

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
    const inboundRequestId = Array.isArray(inboundHeader)
      ? inboundHeader[0]
      : inboundHeader;
    const requestId = inboundRequestId?.trim() || randomUUID();

    request.requestId = requestId;
    response.setHeader(REQUEST_ID_HEADER, requestId);
    this.requestContext.run(requestId, next);
  }
}
