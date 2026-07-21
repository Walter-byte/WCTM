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
  url?: string;
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
          path: request.originalUrl ?? request.url,
        },
        RequestLoggingInterceptor.name
      );
    }

    return next.handle();
  }
}
