import { describe, expect, it, jest } from '@jest/globals';
import { InventoryAlertLevel, WebhookEventStatus } from '@prisma/client';
import type { Job } from 'bullmq';

import type { StructuredLoggerService } from '../common/logging/structured-logger.service';
import type { ApplicationConfigService } from '../config/application-config.service';
import type { InventoryProjectionService } from '../inventory/inventory-projection.service';
import {
  OrderProjectionFailure,
  type OrderProjectionService,
} from '../orders/order-projection.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  REFERENCE_JOB_ATTEMPTS,
  WOOCOMMERCE_WEBHOOK_JOB_NAME,
} from './queue.constants';
import { QueueRuntimeService } from './queue-runtime.service';
import type { OrderNotificationProcessor } from './order-notification.processor';
import type { OrderNotificationScheduler } from './order-notification.scheduler';
import type { InventoryBootstrapProcessor } from './inventory-bootstrap.processor';
import type { InventoryNotificationProcessor } from './inventory-notification.processor';
import type { InventoryNotificationScheduler } from './inventory-notification.scheduler';
import { ReferenceProcessor } from './reference.processor';
import {
  WEBHOOK_PROCESSING_LEASE_TTL_MS,
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
      tenantId: 'ten_untrusted',
      storeId: 'sto_untrusted',
    },
    attemptsMade,
    opts: { attempts: REFERENCE_JOB_ATTEMPTS },
  } as WebhookJob;
}

function setup(
  initialStatus: WebhookEventStatus = WebhookEventStatus.QUEUED,
  processingStartedAt: Date | null = null
) {
  const event = {
    id: 'evt_a',
    tenantId: 'ten_event_untrusted',
    storeId: 'sto_a',
    topic: 'order.created',
    payload: { id: 101 },
    receivedAt: new Date(),
    status: initialStatus,
    processingStartedAt,
    processingAttemptCount: 0,
    completedAt: null as Date | null,
    failedAt: null as Date | null,
    failureCategory: null as string | null,
    failureMessage: null as string | null,
    lastFailureAt: null as Date | null,
    store: {
      id: 'sto_a',
      tenantId: 'ten_a',
      baseUrl: 'https://shop.example',
      consumerKeyEncrypted: 'encrypted-key',
      consumerSecretEncrypted: 'encrypted-secret',
    },
  };
  const updateMany = jest.fn(
    async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      if (where['id'] !== event.id) {
        return { count: 0 };
      }

      let matches = true;
      const status = where['status'];

      if (typeof status === 'string') {
        matches = event.status === status;
      } else if (status && typeof status === 'object' && 'in' in status) {
        matches = (status.in as WebhookEventStatus[]).includes(event.status);
      }

      const alternatives = where['OR'];

      if (Array.isArray(alternatives)) {
        matches = alternatives.some((alternative: unknown) => {
          const candidate = alternative as Record<string, unknown>;

          if (candidate['status'] !== event.status) {
            return false;
          }

          const lease = candidate['processingStartedAt'];

          if (lease && typeof lease === 'object' && 'lte' in lease) {
            return (
              event.processingStartedAt !== null &&
              event.processingStartedAt <= (lease.lte as Date)
            );
          }

          return true;
        });
      }

      if (
        where['processingStartedAt'] instanceof Date &&
        event.processingStartedAt?.getTime() !==
          where['processingStartedAt'].getTime()
      ) {
        matches = false;
      }

      if (!matches) {
        return { count: 0 };
      }

      for (const [key, value] of Object.entries(data)) {
        if (
          key === 'processingAttemptCount' &&
          value &&
          typeof value === 'object' &&
          'increment' in value
        ) {
          event.processingAttemptCount += Number(value.increment);
        } else {
          Object.assign(event, { [key]: value });
        }
      }

      return { count: 1 };
    }
  );
  const findUnique = jest.fn(async () => event);
  const project = jest.fn(async () => undefined);
  const schedule = jest.fn(async () => undefined);
  const projectInventory = jest.fn<
    InventoryProjectionService['projectWebhook']
  >(async () => []);
  const scheduleInventory = jest.fn(async () => undefined);
  const processor = new WooCommerceWebhookProcessor(
    {
      webhookEvent: { updateMany, findUnique },
    } as unknown as PrismaService,
    { project } as unknown as OrderProjectionService,
    {
      projectWebhook: projectInventory,
    } as unknown as InventoryProjectionService,
    { schedule } as unknown as OrderNotificationScheduler,
    { schedule: scheduleInventory } as unknown as InventoryNotificationScheduler
  );

  return {
    event,
    processor,
    project,
    projectInventory,
    schedule,
    scheduleInventory,
    updateMany,
  };
}

describe('WooCommerce order webhook worker lifecycle', () => {
  it.each([
    [
      'order.created',
      {
        id: 101,
        number: 'WC-101',
        status: 'processing',
        currency: 'USD',
        discount_total: '0.00',
        discount_tax: '0.00',
        shipping_total: '5.00',
        shipping_tax: '0.50',
        cart_tax: '2.00',
        total: '27.50',
        total_tax: '2.50',
        customer_id: 7,
        billing: { first_name: 'Test', last_name: 'Customer' },
        shipping: { city: 'Test City', country: 'IR' },
        line_items: [
          { id: 11, name: 'Test product', quantity: 1, total: '20.00' },
        ],
        date_created_gmt: '2026-08-31T08:00:00',
        date_modified_gmt: '2026-08-31T08:00:00',
      },
    ],
    ['order.deleted', { id: 101 }],
  ])(
    'claims a persisted RECEIVED %s event when its published job starts before QUEUED acknowledgement',
    async (topic, payload) => {
      const fixture = setup(WebhookEventStatus.RECEIVED);
      fixture.event.topic = topic;
      fixture.event.payload = payload;

      await expect(fixture.processor.process(webhookJob())).resolves.toEqual(
        expect.objectContaining({ processed: true })
      );

      expect(fixture.project).toHaveBeenCalledWith(
        expect.objectContaining({ topic, payload })
      );
      expect(fixture.event.status).toBe(WebhookEventStatus.COMPLETED);
      expect(fixture.event.processingAttemptCount).toBe(1);
    }
  );

  it('loads tenant and Store identity from the event Store relation', async () => {
    const fixture = setup();

    await expect(fixture.processor.process(webhookJob())).resolves.toEqual({
      webhookEventId: 'evt_a',
      tenantId: 'ten_a',
      storeId: 'sto_a',
      processed: true,
    });

    expect(fixture.project).toHaveBeenCalledWith(
      expect.objectContaining({
        store: expect.objectContaining({
          id: 'sto_a',
          tenantId: 'ten_a',
        }),
      })
    );
    expect(fixture.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'evt_a', topic: 'order.created' })
    );
    expect(fixture.event.status).toBe(WebhookEventStatus.COMPLETED);
    expect(fixture.event.processingAttemptCount).toBe(1);
    expect(fixture.event.completedAt).toBeInstanceOf(Date);
  });

  it.each([
    'product.created',
    'product.updated',
    'product.deleted',
    'product.restored',
  ])('routes %s only to the M19 inventory projector', async (topic) => {
    const fixture = setup();
    fixture.event.topic = topic;
    fixture.event.payload = { id: 101 };
    fixture.projectInventory.mockResolvedValueOnce([
      {
        inventoryItemId: 'inv_a',
        incidentGeneration: 1,
        alertLevel: InventoryAlertLevel.LOW_STOCK,
        sourceWebhookEventId: 'evt_a',
      },
    ]);

    await fixture.processor.process(webhookJob());

    expect(fixture.projectInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        topic,
        store: expect.objectContaining({ id: 'sto_a' }),
      })
    );
    expect(fixture.scheduleInventory).toHaveBeenCalledWith(
      'ten_a',
      'sto_a',
      expect.objectContaining({ inventoryItemId: 'inv_a' })
    );
    expect(fixture.project).not.toHaveBeenCalled();
    expect(fixture.schedule).not.toHaveBeenCalled();
  });

  it('reclaims an expired PROCESSING lease after a crash or restart', async () => {
    const fixture = setup(
      WebhookEventStatus.PROCESSING,
      new Date(Date.now() - WEBHOOK_PROCESSING_LEASE_TTL_MS - 1)
    );

    await fixture.processor.process(webhookJob(1));

    expect(fixture.project).toHaveBeenCalledTimes(1);
    expect(fixture.event.status).toBe(WebhookEventStatus.COMPLETED);
    expect(fixture.event.processingAttemptCount).toBe(1);
  });

  it('does not duplicate work while a PROCESSING lease is active', async () => {
    const fixture = setup(WebhookEventStatus.PROCESSING, new Date());

    await expect(fixture.processor.process(webhookJob(1))).resolves.toEqual(
      expect.objectContaining({ processed: true })
    );

    expect(fixture.project).not.toHaveBeenCalled();
    expect(fixture.event.status).toBe(WebhookEventStatus.PROCESSING);
    expect(fixture.event.processingAttemptCount).toBe(0);
  });

  it('releases retryable reconciliation failures for the next BullMQ attempt', async () => {
    const fixture = setup();
    fixture.project.mockRejectedValueOnce(
      new OrderProjectionFailure('timeout', 'woocommerce-timeout', true)
    );

    await expect(fixture.processor.process(webhookJob())).rejects.toMatchObject(
      { category: 'timeout' }
    );

    expect(fixture.event.status).toBe(WebhookEventStatus.QUEUED);
    expect(fixture.event.failureCategory).toBe('timeout');
    expect(fixture.event.failureMessage).toBe('woocommerce-timeout');
    expect(fixture.event.lastFailureAt).toBeInstanceOf(Date);
  });

  it('fails fast for terminal authentication failures', async () => {
    const fixture = setup();
    fixture.project.mockRejectedValueOnce(
      new OrderProjectionFailure('auth', 'woocommerce-auth', false)
    );

    await expect(fixture.processor.process(webhookJob())).rejects.toMatchObject(
      { name: 'UnrecoverableError' }
    );

    expect(fixture.event.status).toBe(WebhookEventStatus.FAILED);
    expect(fixture.event.failureCategory).toBe('auth');
    expect(fixture.event.failedAt).toBeInstanceOf(Date);
  });

  it('marks exhausted retryable failures FAILED without persisting raw errors', async () => {
    const fixture = setup();
    const error = jest.fn();
    const runtime = new QueueRuntimeService(
      {
        app: { nodeEnv: 'test' },
        redis: { url: 'redis://localhost:6379' },
      } as ApplicationConfigService,
      new ReferenceProcessor(),
      fixture.processor,
      {
        markFailed: jest.fn().mockResolvedValue(undefined as never),
      } as unknown as OrderNotificationProcessor,
      {
        markFailed: jest.fn().mockResolvedValue(undefined as never),
      } as unknown as InventoryBootstrapProcessor,
      {
        markFailed: jest.fn().mockResolvedValue(undefined as never),
      } as unknown as InventoryNotificationProcessor,
      { error } as unknown as StructuredLoggerService
    );
    const safeFailure = new OrderProjectionFailure(
      'transport',
      'woocommerce-transport',
      true
    );

    await runtime.handleFailed(
      webhookJob(REFERENCE_JOB_ATTEMPTS - 1),
      safeFailure
    );
    expect(fixture.event.status).toBe(WebhookEventStatus.QUEUED);

    await runtime.handleFailed(webhookJob(REFERENCE_JOB_ATTEMPTS), safeFailure);
    expect(fixture.event.status).toBe(WebhookEventStatus.FAILED);
    expect(fixture.event.failureCategory).toBe('transport');
    expect(fixture.event.failureMessage).toBe('woocommerce-transport');
    expect(error).toHaveBeenCalledWith(
      'Background job exhausted retry attempts',
      expect.objectContaining({
        jobName: WOOCOMMERCE_WEBHOOK_JOB_NAME,
        attempts: REFERENCE_JOB_ATTEMPTS,
      }),
      QueueRuntimeService.name
    );
  });
});
