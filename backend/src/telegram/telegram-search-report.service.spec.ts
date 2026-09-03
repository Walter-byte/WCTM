import { InventorySyncState, Prisma } from '@prisma/client';

import {
  TelegramSearchReportService,
  tenantDayBounds,
} from './telegram-search-report.service';

const identity = { userId: '100', chatId: '200' };

function fixture(options?: {
  inventoryState?: InventorySyncState;
  exactOrders?: Array<{ wcOrderId: string }>;
  exactSkuItems?: Array<{ id: string }>;
  searchRows?: unknown[];
  reportOrders?: Array<{
    status: string;
    currency: string;
    totals: Prisma.JsonValue;
    lastSyncedAt: Date;
  }>;
}) {
  const prisma = {
    telegramAccount: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'acct_1',
        userId: 'user_1',
        deletedAt: null,
        chatAuthorizations: [{ telegramAccountId: 'acct_1' }],
      }),
    },
    membership: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'membership_1', tenantId: 'tenant_1' }]),
    },
    store: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'store_1',
          inventorySyncState:
            options?.inventoryState ?? InventorySyncState.READY,
          tenant: { timezone: 'America/New_York' },
        },
      ]),
    },
    order: {
      findMany: jest
        .fn()
        .mockImplementation((query: { where?: object }) =>
          query.where && 'wcCreatedAt' in query.where
            ? Promise.resolve(options?.reportOrders ?? [])
            : Promise.resolve(options?.exactOrders ?? [])
        ),
    },
    inventoryItem: {
      findMany: jest.fn().mockResolvedValue(options?.exactSkuItems ?? []),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([
        { alertClassification: 'LOW_STOCK', _count: { _all: 2 } },
        { alertClassification: 'OUT_OF_STOCK', _count: { _all: 1 } },
      ]),
    },
    telegramSearchReference: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue(options?.searchRows ?? []),
  };
  const orders = {
    openProjectedDetail: jest.fn().mockResolvedValue({
      state: 'OK',
      order: { orderNumber: '1001' },
      freshness: { asOf: new Date().toISOString(), delayed: false },
    }),
  };
  const inventory = { openProjectedDetail: jest.fn() };
  const service = new TelegramSearchReportService(
    prisma as never,
    {
      telegram: {
        callbackRefTtlSeconds: 900,
        callbackSigningKey: 'test-signing-key',
        orderFreshnessThresholdSeconds: 3600,
      },
    } as never,
    {
      encrypt: (value: string) => `encrypted:${value}`,
      decrypt: (value: string) => value.replace(/^encrypted:/, ''),
    } as never,
    orders as never,
    inventory as never
  );

  return { service, prisma, orders, inventory };
}

describe('TelegramSearchReportService', () => {
  it('keeps native Order detail ahead of an equal numeric SKU', async () => {
    const { service, prisma, orders } = fixture({
      exactOrders: [{ wcOrderId: '77' }],
      exactSkuItems: [{ id: 'inventory_1001' }],
    });

    const result = await service.search({ telegram: identity, query: '1001' });

    expect(result.state).toBe('ORDER_DETAIL');
    expect(orders.openProjectedDetail).toHaveBeenCalledWith({
      telegram: identity,
      wcOrderId: '77',
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.inventoryItem.findMany).not.toHaveBeenCalled();
  });

  it('returns a scoped exact numeric SKU when no exact Order exists', async () => {
    const row = inventoryRow({
      target_id: 'inventory_312',
      stable_identity: '9501',
      rank: 1,
      display_name: 'Oakley OO9501 Velo Kato',
      sku: '312',
    });
    const { service, prisma, inventory } = fixture({
      exactOrders: [],
      exactSkuItems: [{ id: 'inventory_312' }],
    });
    prisma.$queryRaw.mockImplementation((query: { values?: unknown[] }) =>
      Promise.resolve(query.values?.includes('inventory_312') ? [row] : [])
    );

    const result = await service.search({
      telegram: identity,
      query: '312',
    });

    expect(result.state).toBe('OK');
    if (result.state !== 'OK') return;
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      kind: 'INVENTORY',
      displayName: 'Oakley OO9501 Velo Kato',
      sku: '312',
    });
    expect(prisma.inventoryItem.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant_1',
        storeId: 'store_1',
        remoteDeletedAt: null,
        sku: '312',
      },
      select: { id: true },
      orderBy: [{ displayName: 'asc' }, { wcItemId: 'asc' }],
      take: 200,
    });

    const created =
      prisma.telegramSearchReference.createMany.mock.calls[0]![0].data;
    const pageReference = created.find(
      (reference: Record<string, unknown>) => reference['purpose'] === 'PAGE'
    );
    const resultReference = created.find(
      (reference: Record<string, unknown>) =>
        reference['targetInventoryItemId'] === 'inventory_312'
    );
    prisma.telegramSearchReference.findUnique.mockResolvedValue({
      ...resultReference,
      queryEncrypted: null,
      pageOffset: null,
      targetWcOrderId: null,
    });
    prisma.telegramSearchReference.findFirst.mockResolvedValue({
      id: pageReference.id,
    });
    inventory.openProjectedDetail.mockResolvedValue({
      state: 'OK',
      item: { displayName: 'Oakley OO9501 Velo Kato', sku: '312' },
    });

    const selected = await service.select({
      telegram: identity,
      ref: result.results[0]!.ref,
    });

    expect(selected.state).toBe('INVENTORY');
    expect(inventory.openProjectedDetail).toHaveBeenCalledWith({
      telegram: identity,
      inventoryItemId: 'inventory_312',
    });
  });

  it('keeps numeric SKU prefix results after the exact SKU probe misses', async () => {
    const { service, prisma } = fixture({
      exactOrders: [],
      searchRows: [
        inventoryRow({
          target_id: 'inventory_312',
          stable_identity: '9501',
          rank: 3,
          display_name: 'Oakley OO9501 Velo Kato',
          sku: '312',
        }),
      ],
    });

    const result = await service.search({ telegram: identity, query: '31' });

    expect(result.state).toBe('OK');
    if (result.state !== 'OK') return;
    expect(result.results[0]).toMatchObject({
      kind: 'INVENTORY',
      sku: '312',
    });
    expect(prisma.inventoryItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ sku: '31' }) })
    );
  });

  it('does not choose an ambiguous exact number and returns deterministic list refs', async () => {
    const row = {
      entity_kind: 'ORDER',
      target_id: '77',
      stable_identity: '77',
      rank: 0,
      order_number: '1001',
      status: 'processing',
      customer_display_name: 'Safe Name',
      currency: 'USD',
      total: '10.00',
      wc_created_at: new Date('2026-09-03T10:00:00.000Z'),
      display_name: null,
      sku: null,
      quantity: null,
      classification: null,
      inventory_kind: null,
    };
    const { service, prisma, orders } = fixture({
      exactOrders: [{ wcOrderId: '77' }, { wcOrderId: '88' }],
      searchRows: [row],
    });

    const result = await service.search({ telegram: identity, query: '1001' });

    expect(result.state).toBe('OK');
    expect(orders.openProjectedDetail).not.toHaveBeenCalled();
    expect(prisma.telegramSearchReference.createMany).toHaveBeenCalled();
    const created =
      prisma.telegramSearchReference.createMany.mock.calls[0]![0].data;
    expect(created[0].queryEncrypted).toBe('encrypted:1001');
    expect(created[0].membershipId).toBe('membership_1');
    expect(
      created.some((reference: Record<string, unknown>) =>
        Object.values(reference).includes('Safe Name')
      )
    ).toBe(false);
  });

  it('rejects short general prefixes but allows an exact short SKU', async () => {
    const short = fixture();
    expect(
      await short.service.search({ telegram: identity, query: 'x' })
    ).toEqual({ state: 'QUERY_TOO_SHORT' });

    const exactSku = fixture();
    exactSku.prisma.inventoryItem.count.mockResolvedValue(1);
    expect(
      (await exactSku.service.search({ telegram: identity, query: 'x' })).state
    ).toBe('OK');
  });

  it('separates revenue by currency and excludes non-operational statuses', async () => {
    const synced = new Date();
    const { service } = fixture({
      reportOrders: [
        {
          status: 'processing',
          currency: 'USD',
          totals: { total: '10.10' },
          lastSyncedAt: synced,
        },
        {
          status: 'completed',
          currency: 'USD',
          totals: { total: '20.20' },
          lastSyncedAt: synced,
        },
        {
          status: 'completed',
          currency: 'EUR',
          totals: { total: '5.00' },
          lastSyncedAt: synced,
        },
        {
          status: 'pending',
          currency: 'USD',
          totals: { total: '999' },
          lastSyncedAt: synced,
        },
        {
          status: 'custom',
          currency: 'USD',
          totals: { total: '999' },
          lastSyncedAt: synced,
        },
      ],
    });

    const result = await service.report({ telegram: identity });

    expect(result.state).toBe('OK');
    if (result.state !== 'OK') return;
    expect(result.ordersToday).toBe(5);
    expect(result.sales).toEqual([
      {
        currency: 'EUR',
        gross: '5.00',
        averageOrderValue: '5.00',
        orderCount: 1,
      },
      {
        currency: 'USD',
        gross: '30.30',
        averageOrderValue: '15.15',
        orderCount: 2,
      },
    ]);
    expect(result.inventory).toEqual({
      state: 'READY',
      lowStock: 2,
      outOfStock: 1,
    });
  });

  it('never reports authoritative inventory zero before READY', async () => {
    const { service, prisma } = fixture({
      inventoryState: InventorySyncState.SYNCING,
    });
    const result = await service.report({ telegram: identity });

    expect(result.state).toBe('OK');
    if (result.state !== 'OK') return;
    expect(result.inventory).toEqual({
      state: 'UNAVAILABLE',
      syncState: InventorySyncState.SYNCING,
    });
    expect(prisma.inventoryItem.groupBy).not.toHaveBeenCalled();
  });
});

function inventoryRow(
  overrides: Partial<{
    target_id: string;
    stable_identity: string;
    rank: number;
    display_name: string;
    sku: string;
  }> = {}
) {
  return {
    entity_kind: 'INVENTORY',
    target_id: 'inventory_1',
    stable_identity: '1',
    rank: 4,
    order_number: null,
    status: 'outofstock',
    customer_display_name: null,
    currency: null,
    total: null,
    wc_created_at: null,
    display_name: 'Inventory Item',
    sku: 'SKU-1',
    quantity: '0',
    classification: 'OUT_OF_STOCK',
    inventory_kind: 'PRODUCT',
    ...overrides,
  };
}

describe('tenantDayBounds', () => {
  it.each([
    ['UTC', '2026-09-03T00:00:00.000Z', '2026-09-04T00:00:00.000Z'],
    ['Asia/Tehran', '2026-09-02T20:30:00.000Z', '2026-09-03T20:30:00.000Z'],
    [
      'America/New_York',
      '2026-03-08T05:00:00.000Z',
      '2026-03-09T04:00:00.000Z',
    ],
    [
      'America/New_York',
      '2026-11-01T04:00:00.000Z',
      '2026-11-02T05:00:00.000Z',
    ],
  ])('computes half-open UTC boundaries for %s', (timezone, start, end) => {
    const bounds = tenantDayBounds(new Date(start), timezone);
    expect(bounds.start.toISOString()).toBe(start);
    expect(bounds.end.toISOString()).toBe(end);
  });
});
