import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { RequestContextModule } from '../request-context/request-context.module';
import { RequestLoggingInterceptor } from './request-logging.interceptor';
import { StructuredLoggerService } from './structured-logger.service';

@Global()
@Module({
  imports: [RequestContextModule],
  providers: [
    StructuredLoggerService,
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestLoggingInterceptor,
    },
  ],
  exports: [StructuredLoggerService],
})
export class StructuredLoggingModule {}
