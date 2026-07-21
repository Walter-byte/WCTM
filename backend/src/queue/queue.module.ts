import { Module } from '@nestjs/common';

import { TenantContextModule } from '../tenant/tenant-context.module';
import { QueueRuntimeService } from './queue-runtime.service';
import { ReferenceJobProducer } from './reference-job.producer';
import { ReferenceProcessor } from './reference.processor';

@Module({
  imports: [TenantContextModule],
  providers: [ReferenceProcessor, QueueRuntimeService, ReferenceJobProducer],
  exports: [QueueRuntimeService, ReferenceJobProducer],
})
export class QueueModule {}
