import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';

import { StructuredLoggerService } from './structured-logger.service';

interface HttpRequestDetails {
  method?: string;
  originalUrl?: string;
  path?: string;
  url?: string;
}

function safeRequestPath(request: HttpRequestDetails): string | undefined {
  if (request.path) {
    return request.path;
  }

  return (request.originalUrl ?? request.url)?.split(/[?#]/, 1)[0];
}

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: StructuredLoggerService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const request = context.switchToHttp().getRequest<HttpRequestDetails>();

      this.logger.log(
        'HTTP request received',
        {
          method: request.method,
          path: safeRequestPath(request),
        },
        RequestLoggingInterceptor.name
      );
    }

    return next.handle();
  }
}
