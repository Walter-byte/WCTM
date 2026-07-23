import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@prisma/client';

import { EncryptionService } from '../common/encryption/encryption.service';
import type { ApplicationConfigService } from '../config/application-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  WooCommerceClient,
  WooCommerceClientError,
} from '../woocommerce/client/woocommerce.client';
import {
  decideOrderProjection,
  OrderProjectionService,
  type ProjectableWebhookEvent,
} from './order-projection.service';

interface TestOrder {
  id: string;
  tenantId: string;
  storeId: string;
  wcOrderId: string;
  orderNumber: string;
  status: string;
  currency: string;
  totals: unknown;
  customerSnapshot: unknown;
  lineItemsSnapshot: unknown;
  wcCreatedAt: Date;
  wcModifiedAt: Date;
  projectionFingerprint: string;
  remoteDeletedAt: Date | null;
  lastSyncedAt: Date;
}

function orderPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 101,
    number: 'WC-101',
    status: 'processing',
    currency: 'USD',
    discount_total: '1.00',
    discount_tax: '0.10',
    shipping_total: '5.00',
    shipping_tax: '0.50',
    cart_tax: '2.00',
    total: '26.00',
    total_tax: '2.60',
    customer_id: 7,
    billing: { first_name: 'Jane', last_name: 'Doe' },
    shipping: { city: 'Austin', country: 'US' },
    line_items: [{ id: 11, name: 'Widget', quantity: 2, total: '20.00' }],
    date_created_gmt: '2026-07-23T10:00:00',
    date_modified_gmt: '2026-07-23T10:05:00',
    ...overrides,
  };
}

function setup() {
  const orders: TestOrder[] = [];
  const encryption = new EncryptionService({
    encryption: { key: Buffer.alloc(32, 5).toString('base64') },
  } as ApplicationConfigService);
  const transaction = {
    order: {
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          orders.find(
            (order) =>
              order.tenantId === where['tenantId'] &&
              order.storeId === where['storeId'] &&
              order.wcOrderId === where['wcOrderId']
          ) ?? null
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (
          orders.some(
            (order) =>
              order.storeId === data['storeId'] &&
              order.wcOrderId === data['wcOrderId']
          )
        ) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }

        orders.push({ ...data } as unknown as TestOrder);
        return { id: String(data['id']) };
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const order = orders.find(
            (candidate) =>
              candidate.id === where['id'] &&
              candidate.tenantId === where['tenantId'] &&
              candidate.storeId === where['storeId'] &&
              candidate.wcModifiedAt.getTime() ===
                (where['wcModifiedAt'] as Date).getTime() &&
              candidate.projectionFingerprint ===
                where['projectionFingerprint'] &&
              datesEqual(
                candidate.remoteDeletedAt,
                where['remoteDeletedAt'] as Date | null
              )
          );

          if (order) {
            Object.assign(order, data);
          }

          return { count: order ? 1 : 0 };
        }
      ),
    },
  };
  const prisma = {
    $transaction: jest.fn(
      async (operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction)
    ),
  } as unknown as PrismaService;
  const service = new OrderProjectionService(prisma, encryption, {
    woocommerce: {
      rest: {
        maxAttempts: 3,
        attemptTimeoutMs: 5000,
        totalTimeoutMs: 15000,
        backoffBaseMs: 300,
        backoffFactor: 2,
        jitterRatio: 0.2,
      },
    },
  } as ApplicationConfigService);
  const store = {
    id: 'sto_a',
    tenantId: 'ten_a',
    baseUrl: 'https://shop.example',
    consumerKeyEncrypted: encryption.encrypt('ck_secret'),
    consumerSecretEncrypted: encryption.encrypt('cs_secret'),
  };
  const event = (
    topic: string,
    payload: Record<string, unknown>,
    receivedAt = new Date(Date.now() + 1000)
  ): ProjectableWebhookEvent => ({
    id: 'evt_a',
    topic,
    payload: payload as Prisma.JsonObject,
    receivedAt,
    store,
  });

  return { event, orders, service, transaction };
}

function datesEqual(left: Date | null, right: Date | null): boolean {
  return left === null
    ? right === null
    : right !== null && left.getTime() === right.getTime();
}

describe('OrderProjectionService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('implements older/newer/equal fingerprint ordering rules', () => {
    const stored = new Date('2026-07-23T10:05:00Z');

    expect(
      decideOrderProjection(
        stored,
        'same',
        new Date('2026-07-23T10:04:59Z'),
        'other',
        false
      )
    ).toBe('noop');
    expect(
      decideOrderProjection(
        stored,
        'same',
        new Date('2026-07-23T10:05:01Z'),
        'other',
        false
      )
    ).toBe('apply');
    expect(decideOrderProjection(stored, 'same', stored, 'same', false)).toBe(
      'noop'
    );
    expect(decideOrderProjection(stored, 'same', stored, 'other', false)).toBe(
      'reconcile'
    );
    expect(decideOrderProjection(stored, 'same', stored, 'other', true)).toBe(
      'apply'
    );
  });

  it('upserts idempotently and never regresses on out-of-order events', async () => {
    const fixture = setup();

    await fixture.service.project(
      fixture.event('order.created', orderPayload())
    );
    const firstId = fixture.orders[0]?.id;
    await fixture.service.project(
      fixture.event(
        'order.updated',
        orderPayload({
          status: 'completed',
          date_modified_gmt: '2026-07-23T10:06:00',
        })
      )
    );
    await fixture.service.project(
      fixture.event(
        'order.updated',
        orderPayload({
          status: 'pending',
          date_modified_gmt: '2026-07-23T10:04:00',
        })
      )
    );
    await fixture.service.project(
      fixture.event(
        'order.updated',
        orderPayload({
          status: 'completed',
          date_modified_gmt: '2026-07-23T10:06:00',
        })
      )
    );

    expect(fixture.orders).toHaveLength(1);
    expect(fixture.orders[0]).toMatchObject({
      id: firstId,
      tenantId: 'ten_a',
      storeId: 'sto_a',
      wcOrderId: '101',
      status: 'completed',
    });
  });

  it('reconciles an equal-timestamp fingerprint conflict authoritatively', async () => {
    const fixture = setup();
    const fetchOrder = jest
      .spyOn(WooCommerceClient.prototype, 'fetchOrder')
      .mockResolvedValue(
        orderPayload({
          status: 'completed',
          date_modified_gmt: '2026-07-23T10:05:00',
        })
      );

    await fixture.service.project(
      fixture.event('order.created', orderPayload())
    );
    await fixture.service.project(
      fixture.event(
        'order.updated',
        orderPayload({
          status: 'on-hold',
          date_modified_gmt: '2026-07-23T10:05:00',
        })
      )
    );

    expect(fetchOrder).toHaveBeenCalledWith('101');
    expect(fixture.orders[0]?.status).toBe('completed');
  });

  it('routes a missing modification timestamp to single-order reconciliation', async () => {
    const fixture = setup();
    const payload = orderPayload();
    delete payload.date_modified_gmt;
    const fetchOrder = jest
      .spyOn(WooCommerceClient.prototype, 'fetchOrder')
      .mockResolvedValue(orderPayload({ status: 'on-hold' }));

    await fixture.service.project(fixture.event('order.created', payload));

    expect(fetchOrder).toHaveBeenCalledTimes(1);
    expect(fetchOrder).toHaveBeenCalledWith('101');
    expect(fixture.orders[0]?.status).toBe('on-hold');
  });

  it.each(['timeout', 'transport', 'rate-limited'] as const)(
    'surfaces reconciliation %s as retryable',
    async (category) => {
      const fixture = setup();
      const payload = orderPayload();
      delete payload.date_modified_gmt;
      jest
        .spyOn(WooCommerceClient.prototype, 'fetchOrder')
        .mockRejectedValue(new WooCommerceClientError(category));

      await expect(
        fixture.service.project(fixture.event('order.updated', payload))
      ).rejects.toMatchObject({
        category,
        retryable: true,
      });
    }
  );

  it.each(['auth', 'not-found'] as const)(
    'fails reconciliation %s terminally',
    async (category) => {
      const fixture = setup();
      const payload = orderPayload();
      delete payload.date_modified_gmt;
      jest
        .spyOn(WooCommerceClient.prototype, 'fetchOrder')
        .mockRejectedValue(new WooCommerceClientError(category));

      await expect(
        fixture.service.project(fixture.event('order.updated', payload))
      ).rejects.toEqual(
        expect.objectContaining({
          category,
          retryable: false,
        })
      );
    }
  );

  it('supports verified ID-only delete and full-payload restore transitions', async () => {
    const fixture = setup();

    await fixture.service.project(
      fixture.event('order.created', orderPayload())
    );
    const originalSnapshot = fixture.orders[0]?.lineItemsSnapshot;
    await fixture.service.project(fixture.event('order.deleted', { id: 101 }));

    expect(fixture.orders[0]?.remoteDeletedAt).toBeInstanceOf(Date);
    expect(fixture.orders[0]?.lineItemsSnapshot).toEqual(originalSnapshot);

    await fixture.service.project(
      fixture.event(
        'order.restored',
        orderPayload({ date_modified_gmt: '2026-07-23T10:06:00' })
      )
    );

    expect(fixture.orders[0]?.remoteDeletedAt).toBeNull();
    expect(fixture.orders[0]?.status).toBe('processing');
  });
});
