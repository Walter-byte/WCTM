import { Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';

import { REFERENCE_JOB_ATTEMPTS, REFERENCE_JOB_NAME } from './queue.constants';

export interface ReferenceJobData {
  tenantId: string;
  storeId?: string;
  failUntilAttempt?: number;
}

export interface ReferenceJobResult {
  tenantId: string;
  storeId?: string;
  processed: true;
  attempt: number;
}

const TENANT_ID_PATTERN = /^ten_[A-Za-z0-9-]{1,60}$/;
const STORE_ID_PATTERN = /^sto_[A-Za-z0-9-]{1,60}$/;

export function validateReferenceJobData(
  value: unknown
): asserts value is ReferenceJobData {
  if (value === null || typeof value !== 'object') {
    throw new UnrecoverableError('Reference job payload must be an object');
  }

  const data = value as Partial<ReferenceJobData>;

  if (
    typeof data.tenantId !== 'string' ||
    !TENANT_ID_PATTERN.test(data.tenantId)
  ) {
    throw new UnrecoverableError(
      'Reference job tenantId is required and must be valid'
    );
  }

  if (
    data.storeId !== undefined &&
    (typeof data.storeId !== 'string' || !STORE_ID_PATTERN.test(data.storeId))
  ) {
    throw new UnrecoverableError('Reference job storeId must be valid');
  }

  if (
    data.failUntilAttempt !== undefined &&
    (!Number.isInteger(data.failUntilAttempt) ||
      data.failUntilAttempt < 0 ||
      data.failUntilAttempt >= REFERENCE_JOB_ATTEMPTS)
  ) {
    throw new UnrecoverableError(
      'Reference job failUntilAttempt must be within the retry bound'
    );
  }
}

@Injectable()
export class ReferenceProcessor {
  async process(
    job: Job<ReferenceJobData, ReferenceJobResult, typeof REFERENCE_JOB_NAME>
  ): Promise<ReferenceJobResult> {
    validateReferenceJobData(job.data);

    if ((job.data.failUntilAttempt ?? 0) > job.attemptsMade) {
      throw new Error('Reference job transient failure');
    }

    return {
      tenantId: job.data.tenantId,
      ...(job.data.storeId ? { storeId: job.data.storeId } : {}),
      processed: true,
      attempt: job.attemptsMade + 1,
    };
  }
}
