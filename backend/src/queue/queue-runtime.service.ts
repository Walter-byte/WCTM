import {
  forwardRef,
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { type Job, Queue, UnrecoverableError, Worker } from 'bullmq';

import { StructuredLoggerService } from '../common/logging/structured-logger.service';
import { ApplicationConfigService } from '../config/application-config.service';
import {
  OPERATIONS_QUEUE_NAME,
  ORDER_NOTIFICATION_JOB_NAME,
  REFERENCE_JOB_ATTEMPTS,
  REFERENCE_JOB_BACKOFF_MS,
  REFERENCE_JOB_NAME,
  WOOCOMMERCE_WEBHOOK_JOB_NAME,
} from './queue.constants';
import {
  type OrderNotificationJobData,
  type OrderNotificationJobResult,
  OrderNotificationProcessor,
} from './order-notification.processor';
import {
  type ReferenceJobData,
  type ReferenceJobResult,
  ReferenceProcessor,
} from './reference.processor';
import {
  type WooCommerceWebhookJobData,
  type WooCommerceWebhookJobResult,
  WooCommerceWebhookProcessor,
} from './woocommerce-webhook.processor';

type ReferenceJob = Job<
  ReferenceJobData,
  ReferenceJobResult,
  typeof REFERENCE_JOB_NAME
>;
type WooCommerceWebhookJob = Job<
  WooCommerceWebhookJobData,
  WooCommerceWebhookJobResult,
  typeof WOOCOMMERCE_WEBHOOK_JOB_NAME
>;
type OrderNotificationJob = Job<
  OrderNotificationJobData,
  OrderNotificationJobResult,
  typeof ORDER_NOTIFICATION_JOB_NAME
>;
type OperationsJob =
  ReferenceJob | WooCommerceWebhookJob | OrderNotificationJob;
type OperationsJobData =
  ReferenceJobData | WooCommerceWebhookJobData | OrderNotificationJobData;
type OperationsJobResult =
  ReferenceJobResult | WooCommerceWebhookJobResult | OrderNotificationJobResult;
type OperationsJobName =
  | typeof REFERENCE_JOB_NAME
  | typeof WOOCOMMERCE_WEBHOOK_JOB_NAME
  | typeof ORDER_NOTIFICATION_JOB_NAME;

@Injectable()
export class QueueRuntimeService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly fixedWindowClients = new WeakSet<object>();
  private queue?: Queue<
    OperationsJobData,
    OperationsJobResult,
    OperationsJobName
  >;
  private worker?: Worker<
    OperationsJobData,
    OperationsJobResult,
    OperationsJobName
  >;

  constructor(
    private readonly configuration: ApplicationConfigService,
    private readonly processor: ReferenceProcessor,
    @Inject(forwardRef(() => WooCommerceWebhookProcessor))
    private readonly webhookProcessor: WooCommerceWebhookProcessor,
    private readonly notificationProcessor: OrderNotificationProcessor,
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
      (job) => this.process(job as OperationsJob),
      {
        connection: {
          url: redisUrl,
          maxRetriesPerRequest: null,
        },
        concurrency: 1,
      }
    );
    this.worker.on('failed', (job, error) => {
      void this.handleFailed(job as OperationsJob | undefined, error);
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
    return this.requiredQueue().add(
      REFERENCE_JOB_NAME,
      data
    ) as Promise<ReferenceJob>;
  }

  addWooCommerceWebhookJob(
    data: WooCommerceWebhookJobData,
    jobId: string
  ): Promise<WooCommerceWebhookJob> {
    return this.requiredQueue().add(WOOCOMMERCE_WEBHOOK_JOB_NAME, data, {
      jobId,
    }) as Promise<WooCommerceWebhookJob>;
  }

  addOrderNotificationJob(
    data: OrderNotificationJobData,
    jobId: string
  ): Promise<OrderNotificationJob> {
    return this.requiredQueue().add(ORDER_NOTIFICATION_JOB_NAME, data, {
      jobId,
    }) as Promise<OrderNotificationJob>;
  }

  async ping(): Promise<void> {
    const client = await this.requiredQueue().client;
    const response = await client.info();

    if (response.trim() === '') {
      throw new Error('Redis readiness check failed');
    }
  }

  async incrementFixedWindow(
    key: string,
    windowSeconds: number
  ): Promise<number> {
    const client = await this.requiredQueue().client;
    const commandName = 'm7IncrementFixedWindow';

    if (!this.fixedWindowClients.has(client)) {
      client.defineCommand(commandName, {
        numberOfKeys: 1,
        lua: [
          "local current = redis.call('INCR', KEYS[1])",
          "if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
          'return current',
        ].join('\n'),
      });
      this.fixedWindowClients.add(client);
    }

    const result = await client.runCommand(commandName, [
      key,
      String(windowSeconds),
    ]);
    const count = Number(result);

    if (!Number.isInteger(count) || count < 1) {
      throw new Error('Redis fixed-window counter failed');
    }

    return count;
  }

  async handleFailed(
    job: OperationsJob | undefined,
    error: Error
  ): Promise<void> {
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

    if (job.name === WOOCOMMERCE_WEBHOOK_JOB_NAME) {
      try {
        await this.webhookProcessor.markFailed(job.data, error);
      } catch {
        this.logger.error(
          'WooCommerce webhook dead-letter state update failed',
          {
            queue: OPERATIONS_QUEUE_NAME,
            jobId: job.id ?? null,
          },
          QueueRuntimeService.name
        );
      }
    }

    if (job.name === ORDER_NOTIFICATION_JOB_NAME) {
      try {
        await this.notificationProcessor.markFailed(job.data);
      } catch {
        this.logger.error(
          'Telegram notification dead-letter state update failed',
          {
            queue: OPERATIONS_QUEUE_NAME,
            jobId: job.id ?? null,
          },
          QueueRuntimeService.name
        );
      }
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
    OperationsJobData,
    OperationsJobResult,
    OperationsJobName
  > {
    if (!this.queue) {
      throw new Error('Operations queue is not running');
    }

    return this.queue;
  }

  private process(job: OperationsJob): Promise<OperationsJobResult> {
    if (job.name === WOOCOMMERCE_WEBHOOK_JOB_NAME) {
      return this.webhookProcessor.process(job as WooCommerceWebhookJob);
    }

    if (job.name === ORDER_NOTIFICATION_JOB_NAME) {
      return this.notificationProcessor.process(job as OrderNotificationJob);
    }

    return this.processor.process(job as ReferenceJob);
  }
}
