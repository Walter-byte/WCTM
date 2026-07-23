import { describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { StoreStatus, WebhookEventStatus } from '@prisma/client';
import { createHmac } from 'node:crypto';

import { EncryptionService } from '../common/encryption/encryption.service';
import type { StructuredLoggerService } from '../common/logging/structured-logger.service';
import type { ApplicationConfigService } from '../config/application-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueRuntimeService } from '../queue/queue-runtime.service';
import {
  WooCommerceWebhookJobProducer,
  webhookJobId,
} from '../queue/woocommerce-webhook-job.producer';
import type { WooCommerceWebhookJobData } from '../queue/woocommerce-webhook.processor';
import {
  signaturesMatch,
  WooCommerceWebhookIngestionService,
} from './woocommerce-webhook-ingestion.service';

interface TestStore {
  id: string;
  tenantId: string;
  endpointKey: string;
  webhookSecretEncrypted: string | null;
  status: StoreStatus;
  deletedAt: Date | null;
  tenantDeletedAt: Date | null;
}

interface TestEvent {
  id: string;
  tenantId: string;
  storeId: string;
  webhookId: string;
  deliveryId: string;
  dedupeKey: string;
  topic: string;
  payload: unknown;
  status: WebhookEventStatus;
  queuedAt: Date | null;
}

const SECRET = 's'.repeat(43);
const ENDPOINT_A = `whk_${'a'.repeat(43)}`;
const ENDPOINT_B = `whk_${'b'.repeat(43)}`;
const REQUIRED_HEADER_CASES = [
  {
    label: 'signature',
    name: 'x-wc-webhook-signature',
    error: UnauthorizedException,
  },
  {
    label: 'webhook ID',
    name: 'x-wc-webhook-id',
    error: BadRequestException,
  },
  {
    label: 'delivery ID',
    name: 'x-wc-webhook-delivery-id',
    error: BadRequestException,
  },
  {
    label: 'topic',
    name: 'x-wc-webhook-topic',
    error: BadRequestException,
  },
];

function signature(body: Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

function headers(body: Buffer, deliveryId = 'delivery-1') {
  return {
    'x-wc-webhook-signature': signature(body),
    'x-wc-webhook-id': '42',
    'x-wc-webhook-delivery-id': deliveryId,
    'x-wc-webhook-topic': 'order.created',
  };
}

function setup(options: { missingSecret?: boolean } = {}) {
  const encryption = new EncryptionService({
    encryption: { key: Buffer.alloc(32, 9).toString('base64') },
  } as ApplicationConfigService);
  const stores: TestStore[] = [
    {
      id: 'sto_a',
      tenantId: 'ten_a',
      endpointKey: ENDPOINT_A,
      webhookSecretEncrypted: options.missingSecret
        ? null
        : encryption.encrypt(SECRET),
      status: StoreStatus.ACTIVE,
      deletedAt: null,
      tenantDeletedAt: null,
    },
    {
      id: 'sto_b',
      tenantId: 'ten_b',
      endpointKey: ENDPOINT_B,
      webhookSecretEncrypted: encryption.encrypt('b'.repeat(43)),
      status: StoreStatus.ACTIVE,
      deletedAt: null,
      tenantDeletedAt: null,
    },
  ];
  const events: TestEvent[] = [];
  const storeFindFirst = jest.fn(
    async ({ where }: { where: Record<string, unknown> }) => {
      const found = stores.find(
        (store) =>
          store.endpointKey === where['webhookEndpointKey'] &&
          store.status === where['status'] &&
          store.deletedAt === null &&
          store.tenantDeletedAt === null
      );

      return found
        ? {
            id: found.id,
            tenantId: found.tenantId,
            webhookSecretEncrypted: found.webhookSecretEncrypted,
          }
        : null;
    }
  );
  const eventCreate = jest.fn(
    async ({ data }: { data: Record<string, unknown> }) => {
      if (
        events.some(
          (event) =>
            event.storeId === data['storeId'] &&
            event.dedupeKey === data['dedupeKey']
        )
      ) {
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }

      const event: TestEvent = {
        id: String(data['id']),
        tenantId: String(data['tenantId']),
        storeId: String(data['storeId']),
        webhookId: String(data['webhookId']),
        deliveryId: String(data['deliveryId']),
        dedupeKey: String(data['dedupeKey']),
        topic: String(data['topic']),
        payload: data['payload'],
        status: data['status'] as WebhookEventStatus,
        queuedAt: null,
      };
      events.push(event);

      return {
        id: event.id,
        tenantId: event.tenantId,
        storeId: event.storeId,
        status: event.status,
      };
    }
  );
  const eventFindUnique = jest.fn(
    async ({
      where,
    }: {
      where: {
        storeId_dedupeKey: { storeId: string; dedupeKey: string };
      };
    }) => {
      const event = events.find(
        (candidate) =>
          candidate.storeId === where.storeId_dedupeKey.storeId &&
          candidate.dedupeKey === where.storeId_dedupeKey.dedupeKey
      );

      return event
        ? {
            id: event.id,
            tenantId: event.tenantId,
            storeId: event.storeId,
            status: event.status,
          }
        : null;
    }
  );
  const eventUpdateMany = jest.fn(
    async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const event = events.find(
        (candidate) =>
          candidate.id === where['id'] &&
          candidate.tenantId === where['tenantId'] &&
          candidate.storeId === where['storeId'] &&
          candidate.status === where['status']
      );

      if (event) {
        event.status = data['status'] as WebhookEventStatus;
        event.queuedAt = data['queuedAt'] as Date;
      }

      return { count: event ? 1 : 0 };
    }
  );
  let enqueueFailure = false;
  const publishedJobIds = new Set<string>();
  const addWooCommerceWebhookJob = jest.fn(
    async (data: WooCommerceWebhookJobData, jobIdValue: string) => {
      if (enqueueFailure) {
        throw new Error('redis unavailable');
      }

      publishedJobIds.add(jobIdValue);
      return { id: jobIdValue, data };
    }
  );
  const jobs = new WooCommerceWebhookJobProducer({
    addWooCommerceWebhookJob,
  } as unknown as QueueRuntimeService);
  const prisma = {
    store: { findFirst: storeFindFirst },
    webhookEvent: {
      create: eventCreate,
      findUnique: eventFindUnique,
      updateMany: eventUpdateMany,
    },
  } as unknown as PrismaService;
  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as StructuredLoggerService;
  const service = new WooCommerceWebhookIngestionService(
    prisma,
    encryption,
    jobs,
    logger
  );
  const preload = (
    status: WebhookEventStatus,
    deliveryId = 'delivery-1'
  ): TestEvent => {
    const event: TestEvent = {
      id: 'evt_existing',
      tenantId: 'ten_a',
      storeId: 'sto_a',
      webhookId: '42',
      deliveryId,
      dedupeKey: deliveryId,
      topic: 'order.created',
      payload: { id: 1 },
      status,
      queuedAt: null,
    };
    events.push(event);
    return event;
  };

  return {
    addWooCommerceWebhookJob,
    eventCreate,
    events,
    preload,
    publishedJobIds,
    service,
    setEnqueueFailure(value: boolean) {
      enqueueFailure = value;
    },
    storeFindFirst,
  };
}

describe('WooCommerce webhook ingestion', () => {
  it('persists and enqueues one valid signed delivery with deterministic job ID', async () => {
    const fixture = setup();
    const body = Buffer.from(JSON.stringify({ id: 101, status: 'processing' }));

    await expect(
      fixture.service.receive(ENDPOINT_A, headers(body), body)
    ).resolves.toEqual({ received: true });

    expect(fixture.events).toHaveLength(1);
    expect(fixture.events[0]).toMatchObject({
      tenantId: 'ten_a',
      storeId: 'sto_a',
      webhookId: '42',
      deliveryId: 'delivery-1',
      dedupeKey: 'delivery-1',
      topic: 'order.created',
      status: WebhookEventStatus.QUEUED,
    });
    expect(fixture.addWooCommerceWebhookJob).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookEventId: fixture.events[0]?.id,
        tenantId: 'ten_a',
        storeId: 'sto_a',
      }),
      webhookJobId(String(fixture.events[0]?.id))
    );
    expect(fixture.publishedJobIds.size).toBe(1);
  });

  it('rejects mutated raw bytes before JSON parsing or persistence', async () => {
    const fixture = setup();
    const original = Buffer.from('{"id":1}');
    const mutated = Buffer.from('{"id":2');
    const requestHeaders = {
      ...headers(original),
      'x-wc-webhook-signature': signature(original),
    };

    await expect(
      fixture.service.receive(ENDPOINT_A, requestHeaders, mutated)
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(fixture.eventCreate).not.toHaveBeenCalled();
  });

  it('rejects a wrong or unavailable Store secret', async () => {
    const body = Buffer.from('{"id":1}');
    const wrong = setup();
    const missing = setup({ missingSecret: true });

    await expect(
      wrong.service.receive(
        ENDPOINT_A,
        {
          ...headers(body),
          'x-wc-webhook-signature': signature(body, 'wrong-secret'),
        },
        body
      )
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      missing.service.receive(ENDPOINT_A, headers(body), body)
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each(REQUIRED_HEADER_CASES)(
    'fails closed when the required $label header is missing',
    async ({ name, error }) => {
      const fixture = setup();
      const body = Buffer.from('{"id":1}');
      const requestHeaders: Record<string, string | undefined> = headers(body);
      requestHeaders[name] = undefined;

      await expect(
        fixture.service.receive(ENDPOINT_A, requestHeaders, body)
      ).rejects.toBeInstanceOf(error);
      expect(fixture.eventCreate).not.toHaveBeenCalled();
    }
  );

  it('rejects malformed signature and identity headers', async () => {
    const body = Buffer.from('{"id":1}');
    const malformedSignature = setup();
    const malformedTopic = setup();

    await expect(
      malformedSignature.service.receive(
        ENDPOINT_A,
        {
          ...headers(body),
          'x-wc-webhook-signature': 'not-base64',
        },
        body
      )
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      malformedTopic.service.receive(
        ENDPOINT_A,
        {
          ...headers(body),
          'x-wc-webhook-topic': 'bad topic',
        },
        body
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns a generic 404 for an unknown endpoint before inspecting headers or body', async () => {
    const fixture = setup();

    let captured: unknown;
    try {
      await fixture.service.receive(
        `whk_${'z'.repeat(43)}`,
        {},
        Buffer.from('tenantId=ten_a&storeId=sto_a')
      );
    } catch (error: unknown) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(NotFoundException);
    expect(JSON.stringify(captured)).not.toMatch(/ten_a|sto_a/);
    expect(fixture.eventCreate).not.toHaveBeenCalled();
  });

  it('derives tenant and Store only from the endpoint-routed Store', async () => {
    const fixture = setup();
    const body = Buffer.from(
      JSON.stringify({ tenantId: 'ten_b', storeId: 'sto_b', id: 1 })
    );

    await fixture.service.receive(ENDPOINT_A, headers(body), body);

    expect(fixture.events[0]).toMatchObject({
      tenantId: 'ten_a',
      storeId: 'sto_a',
      payload: { tenantId: 'ten_b', storeId: 'sto_b', id: 1 },
    });
    expect(fixture.storeFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ webhookEndpointKey: ENDPOINT_A }),
      })
    );
  });

  it('leaves a persisted event RECEIVED on enqueue failure and re-enqueues on redelivery', async () => {
    const fixture = setup();
    const body = Buffer.from('{"id":1}');
    fixture.setEnqueueFailure(true);

    await expect(
      fixture.service.receive(ENDPOINT_A, headers(body), body)
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fixture.events).toHaveLength(1);
    expect(fixture.events[0]?.status).toBe(WebhookEventStatus.RECEIVED);

    fixture.setEnqueueFailure(false);
    await expect(
      fixture.service.receive(ENDPOINT_A, headers(body), body)
    ).resolves.toEqual({ received: true });

    expect(fixture.events).toHaveLength(1);
    expect(fixture.events[0]?.status).toBe(WebhookEventStatus.QUEUED);
    expect(fixture.publishedJobIds.size).toBe(1);
    expect(fixture.eventCreate).toHaveBeenCalledTimes(2);
  });

  it.each([
    WebhookEventStatus.QUEUED,
    WebhookEventStatus.PROCESSING,
    WebhookEventStatus.COMPLETED,
    WebhookEventStatus.FAILED,
  ])(
    'acknowledges a duplicate %s event without another row or publication',
    async (status) => {
      const fixture = setup();
      const body = Buffer.from('{"id":1}');
      fixture.preload(status);

      await expect(
        fixture.service.receive(ENDPOINT_A, headers(body), body)
      ).resolves.toEqual({ received: true });

      expect(fixture.events).toHaveLength(1);
      expect(fixture.addWooCommerceWebhookJob).not.toHaveBeenCalled();
      expect(fixture.events[0]?.status).toBe(status);
    }
  );

  it('keeps the verified identity envelope and payload immutable on redelivery', async () => {
    const fixture = setup();
    const event = fixture.preload(WebhookEventStatus.QUEUED);
    const alteredBody = Buffer.from(
      '{"id":999,"tenantId":"ten_b","storeId":"sto_b"}'
    );
    const alteredHeaders = {
      ...headers(alteredBody),
      'x-wc-webhook-id': '999',
      'x-wc-webhook-topic': 'product.updated',
    };

    await fixture.service.receive(ENDPOINT_A, alteredHeaders, alteredBody);

    expect(event).toMatchObject({
      webhookId: '42',
      deliveryId: 'delivery-1',
      topic: 'order.created',
      payload: { id: 1 },
      status: WebhookEventStatus.QUEUED,
    });
    expect(fixture.addWooCommerceWebhookJob).not.toHaveBeenCalled();
  });

  it('rejects validly signed malformed JSON without persistence', async () => {
    const fixture = setup();
    const body = Buffer.from('{"id":');

    await expect(
      fixture.service.receive(ENDPOINT_A, headers(body), body)
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fixture.eventCreate).not.toHaveBeenCalled();
  });

  it('handles timing-safe signature length mismatch without throwing', () => {
    expect(signaturesMatch(Buffer.from('{}'), SECRET, Buffer.alloc(31))).toBe(
      false
    );
  });
});
