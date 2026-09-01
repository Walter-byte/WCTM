import { describe, expect, it, jest } from '@jest/globals';
import {
  InventoryAlertClassification,
  InventoryAlertLevel,
  Prisma,
} from '@prisma/client';

import { EncryptionService } from '../common/encryption/encryption.service';
import type { ApplicationConfigService } from '../config/application-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  WooCommerceClient,
  WooCommerceClientError,
} from '../woocommerce/client/woocommerce.client';
import {
  decideInventoryProjection,
  InventoryProjectionService,
  type InventoryProjectableWebhookEvent,
} from './inventory-projection.service';

interface TestInventoryItem {
  id: string;
  tenantId: string;
  storeId: string;
  wcItemId: string;
  parentWcProductId: string | null;
  wcModifiedAt: Date;
  projectionFingerprint: string;
  remoteDeletedAt: Date | null;
  lastWebhookReceivedAt: Date | null;
  alertClassification: InventoryAlertClassification;
  incidentGeneration: number;
  lowAlertSourceWebhookEventId: string | null;
  lowAlertRecipientsCapturedAt: Date | null;
  outAlertSourceWebhookEventId: string | null;
  outAlertRecipientsCapturedAt: Date | null;
  stockQuantity: string | null;
  stockStatus: string;
  [key: string]: unknown;
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    parent_id: 0,
    type: 'simple',
    name: 'Managed product',
    sku: 'SKU-101',
    manage_stock: true,
    stock_quantity: 10,
    stock_status: 'instock',
    date_modified_gmt: '2026-09-01T08:00:00',
    attributes: [],
    variations: [],
    ...overrides,
  };
}

function setup(lowStockThreshold: number | null = 5) {
  const items: TestInventoryItem[] = [];
  const encryption = new EncryptionService({
    encryption: { key: Buffer.alloc(32, 7).toString('base64') },
  } as ApplicationConfigService);
  const itemDelegate = {
    findFirst: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        items.find(
          (item) =>
            item.tenantId === where['tenantId'] &&
            item.storeId === where['storeId'] &&
            (where['wcItemId'] === undefined ||
              item.wcItemId === where['wcItemId']) &&
            (where['id'] === undefined || item.id === where['id'])
        ) ?? null
    ),
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const identity = JSON.stringify(where);
      return items.filter(
        (item) =>
          item.tenantId === where['tenantId'] &&
          item.storeId === where['storeId'] &&
          (identity.includes(`"wcItemId":"${item.wcItemId}"`) ||
            (item.parentWcProductId !== null &&
              identity.includes(
                `"parentWcProductId":"${item.parentWcProductId}"`
              )))
      );
    }),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (
        items.some(
          (item) =>
            item.storeId === data['storeId'] &&
            item.wcItemId === data['wcItemId']
        )
      ) {
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }

      const item = {
        lowAlertSourceWebhookEventId: null,
        lowAlertRecipientsCapturedAt: null,
        outAlertSourceWebhookEventId: null,
        outAlertRecipientsCapturedAt: null,
        ...data,
      } as unknown as TestInventoryItem;
      items.push(item);
      return { id: item.id };
    }),
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const matching = items.filter((item) => {
          if (
            item.tenantId !== where['tenantId'] ||
            item.storeId !== where['storeId']
          ) {
            return false;
          }

          if (typeof where['id'] === 'string') {
            return (
              item.id === where['id'] &&
              item.projectionFingerprint === where['projectionFingerprint'] &&
              item.alertClassification === where['alertClassification'] &&
              item.incidentGeneration === where['incidentGeneration'] &&
              item.wcModifiedAt.getTime() ===
                (where['wcModifiedAt'] as Date).getTime() &&
              datesEqual(
                item.remoteDeletedAt,
                where['remoteDeletedAt'] as Date | null
              )
            );
          }

          const identity = JSON.stringify(where);
          const hasIdentity =
            identity.includes(`"wcItemId":"${item.wcItemId}"`) ||
            (item.parentWcProductId !== null &&
              identity.includes(
                `"parentWcProductId":"${item.parentWcProductId}"`
              ));
          const clauses = Array.isArray(where['AND'])
            ? (where['AND'] as Array<Record<string, unknown>>)
            : [];
          const modificationClause = clauses.find(
            (clause) => clause['wcModifiedAt'] !== undefined
          );
          const maximumModifiedAt = modificationClause?.['wcModifiedAt'] as
            { lte: Date } | undefined;

          return (
            hasIdentity &&
            (!maximumModifiedAt || item.wcModifiedAt <= maximumModifiedAt.lte)
          );
        });

        for (const item of matching) {
          for (const [key, value] of Object.entries(data)) {
            if (value !== undefined) {
              Object.assign(item, { [key]: value });
            }
          }
        }

        return { count: matching.length };
      }
    ),
  };
  const transaction = {
    store: {
      findFirst: jest.fn(async () => ({ lowStockThreshold })),
    },
    inventoryItem: itemDelegate,
  };
  const prisma = {
    inventoryItem: itemDelegate,
    $transaction: jest.fn(
      async (operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction)
    ),
  } as unknown as PrismaService;
  const service = new InventoryProjectionService(prisma, encryption, {
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
    id: string,
    topic: string,
    payload: Record<string, unknown>,
    receivedAt = new Date(`2026-09-01T09:${id.length % 10}0:00Z`)
  ): InventoryProjectableWebhookEvent => ({
    id,
    topic,
    payload: payload as Prisma.JsonObject,
    receivedAt,
    store,
  });

  return { event, items, service, store };
}

function datesEqual(left: Date | null, right: Date | null): boolean {
  return left === null
    ? right === null
    : right !== null && left.getTime() === right.getTime();
}

describe('M19 inventory projection and incidents', () => {
  it('implements stale, equal, and authoritative fingerprint rules', () => {
    const stored = new Date('2026-09-01T08:00:00Z');

    expect(
      decideInventoryProjection(
        stored,
        'same',
        new Date('2026-09-01T07:59:59Z'),
        'other',
        false
      )
    ).toBe('noop');
    expect(
      decideInventoryProjection(
        stored,
        'same',
        new Date('2026-09-01T08:00:01Z'),
        'other',
        false
      )
    ).toBe('apply');
    expect(
      decideInventoryProjection(stored, 'same', stored, 'same', false)
    ).toBe('noop');
    expect(
      decideInventoryProjection(stored, 'same', stored, 'other', false)
    ).toBe('reconcile');
    expect(
      decideInventoryProjection(stored, 'same', stored, 'other', true)
    ).toBe('apply');
  });

  it('baselines initial low stock without a historical notification', async () => {
    const fixture = setup();

    await fixture.service.projectBootstrapPayload(
      fixture.store,
      product({ stock_quantity: 5 })
    );

    expect(fixture.items[0]).toMatchObject({
      alertClassification: InventoryAlertClassification.LOW_STOCK,
      incidentGeneration: 1,
      lowAlertSourceWebhookEventId: null,
      outAlertSourceWebhookEventId: null,
    });

    await expect(
      fixture.service.projectWebhook(
        fixture.event(
          'evt_repeat',
          'product.updated',
          product({ stock_quantity: 5 })
        )
      )
    ).resolves.toEqual([]);
  });

  it('sends one low episode, one out escalation, then rearms after recovery', async () => {
    const fixture = setup();
    await fixture.service.projectWebhook(
      fixture.event('evt_create', 'product.created', product())
    );

    const low = await fixture.service.projectWebhook(
      fixture.event(
        'evt_low',
        'product.updated',
        product({
          stock_quantity: 5,
          date_modified_gmt: '2026-09-01T08:01:00',
        })
      )
    );
    expect(low).toEqual([
      expect.objectContaining({
        incidentGeneration: 1,
        alertLevel: InventoryAlertLevel.LOW_STOCK,
        sourceWebhookEventId: 'evt_low',
      }),
    ]);

    await expect(
      fixture.service.projectWebhook(
        fixture.event(
          'evt_low_duplicate',
          'product.updated',
          product({
            stock_quantity: 5,
            date_modified_gmt: '2026-09-01T08:01:00',
          })
        )
      )
    ).resolves.toEqual([]);

    const out = await fixture.service.projectWebhook(
      fixture.event(
        'evt_out',
        'product.updated',
        product({
          stock_quantity: 0,
          stock_status: 'outofstock',
          date_modified_gmt: '2026-09-01T08:02:00',
        })
      )
    );
    expect(out).toEqual([
      expect.objectContaining({
        incidentGeneration: 1,
        alertLevel: InventoryAlertLevel.OUT_OF_STOCK,
      }),
    ]);

    await expect(
      fixture.service.projectWebhook(
        fixture.event(
          'evt_out_duplicate',
          'product.updated',
          product({
            stock_quantity: 0,
            stock_status: 'outofstock',
            date_modified_gmt: '2026-09-01T08:02:00',
          })
        )
      )
    ).resolves.toEqual([]);

    await expect(
      fixture.service.projectWebhook(
        fixture.event(
          'evt_partial',
          'product.updated',
          product({
            stock_quantity: 3,
            date_modified_gmt: '2026-09-01T08:03:00',
          })
        )
      )
    ).resolves.toEqual([]);

    await expect(
      fixture.service.projectWebhook(
        fixture.event(
          'evt_healthy',
          'product.updated',
          product({
            stock_quantity: 10,
            date_modified_gmt: '2026-09-01T08:04:00',
          })
        )
      )
    ).resolves.toEqual([]);

    const secondLow = await fixture.service.projectWebhook(
      fixture.event(
        'evt_low_2',
        'product.updated',
        product({
          stock_quantity: 4,
          date_modified_gmt: '2026-09-01T08:05:00',
        })
      )
    );
    expect(secondLow[0]).toMatchObject({
      incidentGeneration: 2,
      alertLevel: InventoryAlertLevel.LOW_STOCK,
    });
  });

  it('does not let stale events or an older equal-time bootstrap page regress stock', async () => {
    const fixture = setup();
    await fixture.service.projectWebhook(
      fixture.event(
        'evt_current',
        'product.created',
        product({ stock_quantity: 9 })
      )
    );

    await fixture.service.projectWebhook(
      fixture.event(
        'evt_stale',
        'product.updated',
        product({
          stock_quantity: 1,
          date_modified_gmt: '2026-09-01T07:59:00',
        })
      )
    );
    await fixture.service.projectBootstrapPayload(
      fixture.store,
      product({ stock_quantity: 1 })
    );

    expect(fixture.items[0]).toMatchObject({
      stockQuantity: '9',
      alertClassification: InventoryAlertClassification.HEALTHY,
    });
  });

  it('deactivates deletion without an alert and restores by authoritative product identity', async () => {
    const fixture = setup();
    const fetchProduct = jest
      .spyOn(WooCommerceClient.prototype, 'fetchProduct')
      .mockRejectedValue(new WooCommerceClientError('not-found'));
    await fixture.service.projectWebhook(
      fixture.event('evt_create', 'product.created', product())
    );

    await expect(
      fixture.service.projectWebhook(
        fixture.event('evt_delete', 'product.deleted', { id: 101 })
      )
    ).resolves.toEqual([]);
    expect(fixture.items[0]).toMatchObject({
      alertClassification: InventoryAlertClassification.HEALTHY,
    });
    expect(fixture.items[0]?.remoteDeletedAt).toBeInstanceOf(Date);

    fetchProduct.mockResolvedValue(product());
    await fixture.service.projectWebhook(
      fixture.event('evt_restore', 'product.restored', product())
    );
    expect(fixture.items[0]?.remoteDeletedAt).toBeNull();
    expect(fetchProduct).toHaveBeenLastCalledWith('101');
  });

  it('does not apply an older product deletion over a newer stock projection', async () => {
    const fixture = setup();
    await fixture.service.projectWebhook(
      fixture.event(
        'evt_current',
        'product.created',
        product({ date_modified_gmt: '2026-09-01T08:05:00' })
      )
    );

    await fixture.service.projectWebhook(
      fixture.event(
        'evt_old_delete',
        'product.deleted',
        product({ date_modified_gmt: '2026-09-01T08:04:00' })
      )
    );

    expect(fixture.items[0]?.remoteDeletedAt).toBeNull();
    expect(fixture.items[0]?.stockQuantity).toBe('10');
  });
});
