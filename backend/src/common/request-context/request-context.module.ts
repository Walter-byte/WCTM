import { Global, Module } from '@nestjs/common';

import { CorrelationIdMiddleware } from './correlation-id.middleware';
import { RequestContextService } from './request-context.service';

@Global()
@Module({
  providers: [RequestContextService, CorrelationIdMiddleware],
  exports: [RequestContextService, CorrelationIdMiddleware],
})
export class RequestContextModule {}
