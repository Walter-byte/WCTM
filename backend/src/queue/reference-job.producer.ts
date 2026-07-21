import { Injectable } from '@nestjs/common';

import { TenantContextService } from '../tenant/tenant-context.service';
import { QueueRuntimeService } from './queue-runtime.service';
import {
  type ReferenceJobData,
  validateReferenceJobData,
} from './reference.processor';

export interface EnqueueReferenceJobInput {
  storeId?: string;
  failUntilAttempt?: number;
}

@Injectable()
export class ReferenceJobProducer {
  constructor(
    private readonly queueRuntime: QueueRuntimeService,
    private readonly tenantContext: TenantContextService
  ) {}

  async enqueue(
    input: EnqueueReferenceJobInput = {}
  ): Promise<{ jobId: string }> {
    const data: ReferenceJobData = {
      tenantId: this.tenantContext.active.tenantId,
      ...(input.storeId ? { storeId: input.storeId } : {}),
      ...(input.failUntilAttempt === undefined
        ? {}
        : { failUntilAttempt: input.failUntilAttempt }),
    };

    validateReferenceJobData(data);

    const job = await this.queueRuntime.addReferenceJob(data);

    return { jobId: String(job.id) };
  }
}
