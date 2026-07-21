import {
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { type Job, Queue, UnrecoverableError, Worker } from 'bullmq';

import { StructuredLoggerService } from '../common/logging/structured-logger.service';
import { ApplicationConfigService } from '../config/application-config.service';
import {
  OPERATIONS_QUEUE_NAME,
  REFERENCE_JOB_ATTEMPTS,
  REFERENCE_JOB_BACKOFF_MS,
  REFERENCE_JOB_NAME,
} from './queue.constants';
import {
  type ReferenceJobData,
  type ReferenceJobResult,
  ReferenceProcessor,
} from './reference.processor';

type ReferenceJob = Job<
  ReferenceJobData,
  ReferenceJobResult,
  typeof REFERENCE_JOB_NAME
>;

@Injectable()
export class QueueRuntimeService
  implements OnModuleInit, OnApplicationShutdown
{
  private queue?: Queue<
    ReferenceJobData,
    ReferenceJobResult,
    typeof REFERENCE_JOB_NAME
  >;
  private worker?: Worker<
    ReferenceJobData,
    ReferenceJobResult,
    typeof REFERENCE_JOB_NAME
  >;

  constructor(
    private readonly configuration: ApplicationConfigService,
    private readonly processor: ReferenceProcessor,
    private readonly logger: StructuredLoggerService
  ) {}

  onModuleInit(): void {
    if (this.configuration.app.nodeEnv === 'test') {
      return;
    }

    const redisUrl = this.configuration.redis.url;

    this.queue = new Queue(OPERATIONS_QUEUE_NAME, {
      connection: {
        url: redisUrl,
        maxRetriesPerRequest: 1,
      },
      defaultJobOptions: {
        attempts: REFERENCE_JOB_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: REFERENCE_JOB_BACKOFF_MS,
        },
      },
    });
    this.worker = new Worker(
      OPERATIONS_QUEUE_NAME,
      (job) => this.processor.process(job),
      {
        connection: {
          url: redisUrl,
          maxRetriesPerRequest: null,
        },
        concurrency: 1,
      }
    );
    this.worker.on('failed', (job, error) => {
      this.handleFailed(job, error);
    });
    this.worker.on('error', (error) => {
      this.logger.error(
        'Background worker error',
        { errorType: error.name },
        QueueRuntimeService.name
      );
    });
  }

  addReferenceJob(data: ReferenceJobData): Promise<ReferenceJob> {
    return this.requiredQueue().add(REFERENCE_JOB_NAME, data);
  }

  async ping(): Promise<void> {
    const client = await this.requiredQueue().client;
    const response = await client.info();

    if (response.trim() === '') {
      throw new Error('Redis readiness check failed');
    }
  }

  handleFailed(job: ReferenceJob | undefined, error: Error): void {
    if (!job) {
      this.logger.error(
        'Background job failed without job context',
        { queue: OPERATIONS_QUEUE_NAME },
        QueueRuntimeService.name
      );
      return;
    }

    const attempts = job.opts.attempts ?? 1;

    if (job.attemptsMade < attempts && !(error instanceof UnrecoverableError)) {
      return;
    }

    const tenantId =
      typeof job.data?.tenantId === 'string' &&
      job.data.tenantId.startsWith('ten_')
        ? job.data.tenantId
        : null;
    const storeId =
      typeof job.data?.storeId === 'string' &&
      job.data.storeId.startsWith('sto_')
        ? job.data.storeId
        : undefined;

    this.logger.error(
      'Background job exhausted retry attempts',
      {
        queue: OPERATIONS_QUEUE_NAME,
        jobId: job.id ?? null,
        jobName: job.name,
        tenantId,
        ...(storeId ? { storeId } : {}),
        attempts,
      },
      QueueRuntimeService.name
    );
  }

  async onApplicationShutdown(): Promise<void> {
    const worker = this.worker;
    const queue = this.queue;

    this.worker = undefined;
    this.queue = undefined;

    try {
      await worker?.close();
    } finally {
      await queue?.close();
    }
  }

  private requiredQueue(): Queue<
    ReferenceJobData,
    ReferenceJobResult,
    typeof REFERENCE_JOB_NAME
  > {
    if (!this.queue) {
      throw new Error('Operations queue is not running');
    }

    return this.queue;
  }
}
