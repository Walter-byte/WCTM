import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { InventorySyncState, StoreStatus } from '@prisma/client';
import type { Job } from 'bullmq';

import { EncryptionService } from '../common/encryption/encryption.service';
import type { ApplicationConfigService } from '../config/application-config.service';
import type { InventoryProjectionService } from '../inventory/inventory-projection.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  WooCommerceClient,
  WooCommerceClientError,
} from '../woocommerce/client/woocommerce.client';
import { InventoryBootstrapProcessor } from './inventory-bootstrap.processor';
import {
  type InventoryBootstrapJobData,
  type InventoryBootstrapJobResult,
  inventoryBootstrapJobId,
  InventoryBootstrapScheduler,
} from './inventory-bootstrap.scheduler';
import { INVENTORY_BOOTSTRAP_JOB_NAME } from './queue.constants';
import type { QueueRuntimeService } from './queue-runtime.service';

type BootstrapJob = Job<
  InventoryBootstrapJobData,
  InventoryBootstrapJobResult,
  typeof INVENTORY_BOOTSTRAP_JOB_NAME
>;

function job(revision: number): BootstrapJob {
  return {
    id: inventoryBootstrapJobId('sto_a', revision),
    name: INVENTORY_BOOTSTRAP_JOB_NAME,
    data: { tenantId: 'ten_a', storeId: 'sto_a', revision },
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as BootstrapJob;
}

function inventoryPayload(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    parent_id: 0,
    type: 'simple',
    name: `Product ${id}`,
    sku: '',
    manage_stock: true,
    stock_quantity: 10,
    stock_status: 'instock',
    date_modified_gmt: '2026-09-01T08:00:00',
    attributes: [],
    variations: [],
    ...overrides,
  };
}

function processorFixture() {
  const encryption = new EncryptionService({
    encryption: { key: Buffer.alloc(32, 8).toString('base64') },
  } as ApplicationConfigService);
  const store = {
    id: 'sto_a',
    tenantId: 'ten_a',
    status: StoreStatus.ACTIVE,
    baseUrl: 'https://shop.example',
    consumerKeyEncrypted: encryption.encrypt('ck_secret'),
    consumerSecretEncrypted: encryption.encrypt('cs_secret'),
    inventorySyncState: InventorySyncState.SYNCING as InventorySyncState,
    inventoryBootstrapProductPage: 1,
    inventoryBootstrapVariationPage: 1,
    inventoryBootstrapParentIds: [] as string[],
    inventoryBootstrapProductsDone: false,
    inventoryBootstrapRevision: 1,
    inventoryBootstrapLeaseAt: null as Date | null,
    inventoryBootstrapCompletedAt: null as Date | null,
    inventoryBootstrapFailedAt: null as Date | null,
    inventoryBootstrapFailureCode: null as string | null,
  };
  const updateMany = jest.fn(
    async ({
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      for (const [key, value] of Object.entries(data)) {
        if (
          key === 'inventoryBootstrapRevision' &&
          value &&
          typeof value === 'object' &&
          'increment' in value
        ) {
          store.inventoryBootstrapRevision += Number(value.increment);
        } else if (value !== undefined) {
          Object.assign(store, { [key]: value });
        }
      }
      return { count: 1 };
    }
  );
  const findFirst = jest.fn(async () => ({ ...store }));
  const projectBootstrapPayload = jest.fn(async () => undefined);
  const enqueue = jest.fn(async () => ({ jobId: 'next' }));
  const processor = new InventoryBootstrapProcessor(
    {
      store: { updateMany, findFirst },
    } as unknown as PrismaService,
    { projectBootstrapPayload } as unknown as InventoryProjectionService,
    { enqueue } as unknown as InventoryBootstrapScheduler,
    encryption,
    {
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
    } as ApplicationConfigService
  );

  return { enqueue, processor, projectBootstrapPayload, store, updateMany };
}

describe('M19 bounded resumable inventory bootstrap', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('atomically initializes once and uses one deterministic queue identity', async () => {
    const store: {
      inventorySyncState: InventorySyncState;
      inventoryBootstrapRevision: number;
    } = {
      inventorySyncState: InventorySyncState.UNINITIALIZED,
      inventoryBootstrapRevision: 0,
    };
    const updateMany = jest.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (where['inventoryBootstrapFailureCode']) {
          return { count: 0 };
        }

        store.inventorySyncState = data[
          'inventorySyncState'
        ] as InventorySyncState;
        store.inventoryBootstrapRevision += 1;
        return { count: 1 };
      }
    );
    const addInventoryBootstrapJob = jest.fn(async () => ({ id: 'job' }));
    const scheduler = new InventoryBootstrapScheduler(
      {
        store: {
          findFirst: jest.fn(async () => ({ ...store })),
          updateMany,
        },
      } as unknown as PrismaService,
      { addInventoryBootstrapJob } as unknown as QueueRuntimeService
    );

    await scheduler.ensureInitialized('ten_a', 'sto_a');
    await scheduler.ensureInitialized('ten_a', 'sto_a');

    expect(
      updateMany.mock.calls.filter(
        ([argument]) => argument.data['inventorySyncState'] !== undefined
      )
    ).toHaveLength(1);
    expect(addInventoryBootstrapJob).toHaveBeenCalledTimes(2);
    expect(addInventoryBootstrapJob).toHaveBeenNthCalledWith(
      1,
      { tenantId: 'ten_a', storeId: 'sto_a', revision: 1 },
      inventoryBootstrapJobId('sto_a', 1)
    );
    expect(addInventoryBootstrapJob).toHaveBeenNthCalledWith(
      2,
      { tenantId: 'ten_a', storeId: 'sto_a', revision: 1 },
      inventoryBootstrapJobId('sto_a', 1)
    );
  });

  it('keeps an enqueue failure explicitly incomplete and safe to retry', async () => {
    const store: {
      inventorySyncState: InventorySyncState;
      inventoryBootstrapRevision: number;
      inventoryBootstrapFailureCode: string | null;
    } = {
      inventorySyncState: InventorySyncState.UNINITIALIZED,
      inventoryBootstrapRevision: 0,
      inventoryBootstrapFailureCode: null as string | null,
    };
    const updateMany = jest.fn(
      async ({ data }: { data: Record<string, unknown> }) => {
        if (data['inventorySyncState']) {
          store.inventorySyncState = data[
            'inventorySyncState'
          ] as InventorySyncState;
          store.inventoryBootstrapRevision += 1;
        }
        if (data['inventoryBootstrapFailureCode'] !== undefined) {
          store.inventoryBootstrapFailureCode = data[
            'inventoryBootstrapFailureCode'
          ] as string | null;
        }
        return { count: 1 };
      }
    );
    const scheduler = new InventoryBootstrapScheduler(
      {
        store: {
          findFirst: jest.fn(async () => ({ ...store })),
          updateMany,
        },
      } as unknown as PrismaService,
      {
        addInventoryBootstrapJob: jest.fn(async () => {
          throw new Error('redis unavailable');
        }),
      } as unknown as QueueRuntimeService
    );

    await expect(
      scheduler.ensureInitialized('ten_a', 'sto_a')
    ).resolves.toMatchObject({
      state: InventorySyncState.SYNCING,
      enqueueFailed: true,
    });
    expect(store.inventorySyncState).toBe(InventorySyncState.SYNCING);
    expect(store.inventoryBootstrapFailureCode).toBe(
      'bootstrap-enqueue-failed'
    );
  });

  it('marks ready only after a complete bounded current product page', async () => {
    const fixture = processorFixture();
    const fetchProductsPage = jest
      .spyOn(WooCommerceClient.prototype, 'fetchProductsPage')
      .mockResolvedValue([inventoryPayload(101)]);

    await expect(fixture.processor.process(job(1))).resolves.toMatchObject({
      ready: true,
    });

    expect(fetchProductsPage).toHaveBeenCalledWith(1, 25);
    expect(fetchProductsPage).toHaveBeenCalledTimes(1);
    expect(fixture.projectBootstrapPayload).toHaveBeenCalledTimes(1);
    expect(fixture.store.inventorySyncState).toBe(InventorySyncState.READY);
    expect(fixture.store.inventoryBootstrapCompletedAt).toBeInstanceOf(Date);
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });

  it('persists product and variation progress across deterministic continuations', async () => {
    const fixture = processorFixture();
    const variable = inventoryPayload(101, {
      type: 'variable',
      manage_stock: false,
      stock_quantity: null,
      variations: [201, 202],
    });
    const independent = inventoryPayload(201, {
      parent_id: 101,
      type: 'variation',
      stock_quantity: 2,
    });
    const inherited = inventoryPayload(202, {
      parent_id: 101,
      type: 'variation',
      manage_stock: 'parent',
      stock_quantity: null,
    });
    jest
      .spyOn(WooCommerceClient.prototype, 'fetchProductsPage')
      .mockResolvedValue([variable]);
    const fetchVariations = jest
      .spyOn(WooCommerceClient.prototype, 'fetchProductVariationsPage')
      .mockResolvedValue([independent, inherited]);

    await expect(fixture.processor.process(job(1))).resolves.toMatchObject({
      ready: false,
    });
    expect(fixture.store.inventoryBootstrapParentIds).toEqual(['101']);
    expect(fixture.store.inventoryBootstrapProductsDone).toBe(true);
    expect(fixture.store.inventoryBootstrapRevision).toBe(2);
    expect(fixture.enqueue).toHaveBeenCalledWith({
      tenantId: 'ten_a',
      storeId: 'sto_a',
      revision: 2,
    });

    await expect(fixture.processor.process(job(2))).resolves.toMatchObject({
      ready: true,
    });
    expect(fetchVariations).toHaveBeenCalledWith('101', 1, 25);
    expect(fetchVariations).toHaveBeenCalledTimes(1);
    expect(fixture.projectBootstrapPayload).toHaveBeenCalledTimes(3);
    expect(fixture.store.inventoryBootstrapParentIds).toEqual([]);
    expect(fixture.store.inventorySyncState).toBe(InventorySyncState.READY);
  });

  it('keeps retryable failures incomplete and marks exhausted work recoverable', async () => {
    const fixture = processorFixture();
    jest
      .spyOn(WooCommerceClient.prototype, 'fetchProductsPage')
      .mockRejectedValue(new WooCommerceClientError('timeout'));

    await expect(fixture.processor.process(job(1))).rejects.toMatchObject({
      category: 'timeout',
    });
    expect(fixture.store.inventorySyncState).toBe(InventorySyncState.SYNCING);
    expect(fixture.store.inventoryBootstrapLeaseAt).toBeNull();

    await fixture.processor.markFailed(job(1).data, new Error('secret detail'));
    expect(fixture.store.inventorySyncState).toBe(InventorySyncState.FAILED);
    expect(fixture.store.inventoryBootstrapFailureCode).toBe(
      'inventory-bootstrap-failed'
    );
    expect(JSON.stringify(fixture.store)).not.toContain('secret detail');
    expect(fixture.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ inventoryBootstrapRevision: 1 }),
      })
    );
  });

  it('does not enqueue obsolete continuation work after the Store is ready', async () => {
    const fixture = processorFixture();
    fixture.store.inventorySyncState = InventorySyncState.READY;
    fixture.store.inventoryBootstrapRevision = 2;
    fixture.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(fixture.processor.process(job(1))).resolves.toMatchObject({
      ready: true,
    });
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });

  it('retries rather than completing a current revision that remains leased', async () => {
    const fixture = processorFixture();
    fixture.store.inventoryBootstrapLeaseAt = new Date();
    fixture.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(fixture.processor.process(job(1))).rejects.toThrow(
      'already leased'
    );
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });
});
