import { describe, expect, it, jest } from '@jest/globals';
import { WebhookEventStatus } from '@prisma/client';
import type { Job } from 'bullmq';

import type { StructuredLoggerService } from '../common/logging/structured-logger.service';
import type { ApplicationConfigService } from '../config/application-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  REFERENCE_JOB_ATTEMPTS,
  WOOCOMMERCE_WEBHOOK_JOB_NAME,
} from './queue.constants';
import { QueueRuntimeService } from './queue-runtime.service';
import { ReferenceProcessor } from './reference.processor';
import {
  type WooCommerceWebhookJobData,
  type WooCommerceWebhookJobResult,
  WooCommerceWebhookProcessor,
} from './woocommerce-webhook.processor';

type WebhookJob = Job<
  WooCommerceWebhookJobData,
  WooCommerceWebhookJobResult,
  typeof WOOCOMMERCE_WEBHOOK_JOB_NAME
>;

function webhookJob(attemptsMade = 0): WebhookJob {
  return {
    id: 'woocommerce-webhook-evt_a',
    name: WOOCOMMERCE_WEBHOOK_JOB_NAME,
    data: {
      webhookEventId: 'evt_a',
      tenantId: 'ten_a',
      storeId: 'sto_a',
    },
    attemptsMade,
    opts: { attempts: REFERENCE_JOB_ATTEMPTS },
  } as WebhookJob;
}

function setup() {
  const event = {
    id: 'evt_a',
    tenantId: 'ten_a',
    storeId: 'sto_a',
    status: WebhookEventStatus.QUEUED,
    processingAt: null as Date | null,
    completedAt: null as Date | null,
    failedAt: null as Date | null,
  };
  const updateMany = jest.fn(
    async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const statusFilter = where['status'];
      const allowedStatuses =
        statusFilter !== null &&
        typeof statusFilter === 'object' &&
        'in' in statusFilter
          ? (statusFilter.in as WebhookEventStatus[])
          : [statusFilter as WebhookEventStatus];
      const matches =
        event.id === where['id'] &&
        event.tenantId === where['tenantId'] &&
        event.storeId === where['storeId'] &&
        allowedStatuses.includes(event.status);

      if (matches) {
        Object.assign(event, data);
      }

      return { count: matches ? 1 : 0 };
    }
  );
  const processor = new WooCommerceWebhookProcessor({
    webhookEvent: { updateMany },
  } as unknown as PrismaService);

  return { event, processor, updateMany };
}

describe('WooCommerce webhook lifecycle worker', () => {
  it('advances only operational lifecycle state through completion', async () => {
    const fixture = setup();

    await expect(fixture.processor.process(webhookJob())).resolves.toEqual({
      webhookEventId: 'evt_a',
      tenantId: 'ten_a',
      storeId: 'sto_a',
      processed: true,
    });

    expect(fixture.event.status).toBe(WebhookEventStatus.COMPLETED);
    expect(fixture.event.processingAt).toBeInstanceOf(Date);
    expect(fixture.event.completedAt).toBeInstanceOf(Date);
    expect(fixture.updateMany).toHaveBeenCalledTimes(2);
  });

  it('marks the event FAILED only when bounded queue attempts are exhausted', async () => {
    const fixture = setup();
    const error = jest.fn();
    const runtime = new QueueRuntimeService(
      {
        app: { nodeEnv: 'test' },
        redis: { url: 'redis://localhost:6379' },
      } as ApplicationConfigService,
      new ReferenceProcessor(),
      fixture.processor,
      { error } as unknown as StructuredLoggerService
    );

    await runtime.handleFailed(
      webhookJob(REFERENCE_JOB_ATTEMPTS - 1),
      new Error('retry')
    );
    expect(fixture.event.status).toBe(WebhookEventStatus.QUEUED);

    await runtime.handleFailed(
      webhookJob(REFERENCE_JOB_ATTEMPTS),
      new Error('terminal raw error')
    );
    expect(fixture.event.status).toBe(WebhookEventStatus.FAILED);
    expect(fixture.event.failedAt).toBeInstanceOf(Date);
    expect(error).toHaveBeenCalledWith(
      'Background job exhausted retry attempts',
      expect.objectContaining({
        jobName: WOOCOMMERCE_WEBHOOK_JOB_NAME,
        attempts: REFERENCE_JOB_ATTEMPTS,
      }),
      QueueRuntimeService.name
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      'terminal raw error'
    );
  });
});
