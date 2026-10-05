import { describe, expect, it, jest } from '@jest/globals';
import { PrismaClient, StoreStatus } from '@prisma/client';

import type { EncryptionService } from '../common/encryption/encryption.service';
import { PilotDataService } from './pilot-data.service';

const TARGET = {
  tenantId: 'ten_a',
  storeId: 'sto_a',
  baseUrl: 'https://shop.example.test',
};

function setup(found = true) {
  const store = {
    id: TARGET.storeId,
    tenantId: TARGET.tenantId,
    baseUrl: TARGET.baseUrl,
    status: StoreStatus.ACTIVE as StoreStatus,
    deletedAt: null as Date | null,
  };
  const findMany = jest.fn(async () => (found ? [store] : []));
  const storeUpdate = jest.fn(async () => ({ count: 1 }));
  const updateMany = jest.fn(async () => ({ count: 1 }));
  const auditCreate = jest.fn(async () => ({ id: 'aud_a' }));
  const transaction = {
    store: { updateMany: storeUpdate },
    telegramChatAuthorization: { updateMany },
    webhookEvent: { updateMany },
    order: { updateMany },
    inventoryItem: { updateMany },
    telegramCallbackReference: { updateMany },
    telegramSearchReference: { updateMany },
    telegramOrderNoteAction: { updateMany },
    telegramOrderStatusWrite: { updateMany },
    auditLog: { create: auditCreate },
  };
  const database = {
    store: { findMany },
    order: {
      count: jest.fn(async () => 2),
      findMany: jest.fn(async () => []),
      updateMany,
    },
    webhookEvent: {
      count: jest.fn(async () => 3),
      findMany: jest.fn(async () => []),
      updateMany,
    },
    inventoryItem: {
      count: jest.fn(async () => 1),
      findMany: jest.fn(async () => []),
    },
    telegramOrderNotificationDelivery: { count: jest.fn(async () => 1) },
    telegramInventoryNotificationDelivery: { count: jest.fn(async () => 0) },
    $transaction: jest.fn(
      async (callback: (tx: typeof transaction) => Promise<void>) =>
        callback(transaction)
    ),
  };
  const encryption = {
    encrypt: jest.fn(() => 'encrypted-revoked'),
  } as unknown as EncryptionService;
  return {
    service: new PilotDataService(
      database as unknown as PrismaClient,
      encryption
    ),
    database,
    transaction,
    store,
    findMany,
    storeUpdate,
    updateMany,
  };
}

describe('pilot operator privacy boundary', () => {
  it('fails closed when the exact Tenant, Store and URL do not resolve', async () => {
    const fixture = setup(false);
    await expect(fixture.service.inspect(TARGET)).rejects.toThrow('identity');
    await expect(fixture.service.disconnect(TARGET)).rejects.toThrow(
      'identity'
    );
    await expect(fixture.service.erase(TARGET)).rejects.toThrow('identity');
    expect(fixture.database.$transaction).not.toHaveBeenCalled();
    expect(fixture.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sto_a', tenantId: 'ten_a', baseUrl: TARGET.baseUrl },
      })
    );
  });

  it('dry-run inspection reports scoped counts without mutating data', async () => {
    const fixture = setup();
    await expect(fixture.service.inspect(TARGET)).resolves.toMatchObject({
      tenantId: 'ten_a',
      storeId: 'sto_a',
      counts: { orders: 2, events: 3, inventory: 1 },
    });
    expect(fixture.database.$transaction).not.toHaveBeenCalled();
  });

  it('disconnect revokes credentials, ingestion and Telegram Store context', async () => {
    const fixture = setup();
    await fixture.service.disconnect(TARGET);

    expect(fixture.storeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'ten_a',
          id: 'sto_a',
          baseUrl: TARGET.baseUrl,
        }),
        data: expect.objectContaining({
          status: StoreStatus.DISCONNECTED,
          pluginSecretHash: null,
          webhookSecretEncrypted: null,
          webhookEndpointKey: null,
          consumerKeyEncrypted: 'encrypted-revoked',
        }),
      })
    );
    expect(
      fixture.transaction.telegramChatAuthorization.updateMany
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { activeStoreId: 'sto_a', activeTenantId: 'ten_a' },
      })
    );
    expect(fixture.transaction.webhookEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'ten_a', storeId: 'sto_a' }),
      })
    );
  });

  it('revokes credentials even when a Store was already soft-deleted', async () => {
    const fixture = setup();
    fixture.store.status = StoreStatus.DISCONNECTED;
    fixture.store.deletedAt = new Date();
    await fixture.service.disconnect(TARGET);
    expect(fixture.storeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: TARGET.storeId,
          tenantId: TARGET.tenantId,
          baseUrl: TARGET.baseUrl,
        },
        data: expect.objectContaining({
          pluginSecretHash: null,
          webhookSecretEncrypted: null,
        }),
      })
    );
  });

  it('requires verified disconnect before scoped erasure', async () => {
    const fixture = setup();
    await expect(fixture.service.erase(TARGET)).rejects.toThrow('disconnect');
    expect(fixture.database.$transaction).not.toHaveBeenCalled();
  });

  it('scrubs old terminal payloads in scoped batches, with a non-mutating dry run', async () => {
    const fixture = setup();
    const old = {
      id: 'evt_a',
      topic: 'order.updated',
      status: 'COMPLETED',
      payload: {
        id: 12,
        billing: { first_name: 'A', email: 'private@example.test' },
        meta_data: [{ key: 'private' }],
      },
    };
    fixture.database.webhookEvent.findMany
      .mockResolvedValueOnce([old] as never)
      .mockResolvedValueOnce([]);
    await expect(
      fixture.service.scrubHistorical(TARGET, false)
    ).resolves.toEqual({
      changedEvents: 1,
      changedOrders: 0,
      executed: false,
    });
    expect(fixture.database.webhookEvent.updateMany).not.toHaveBeenCalled();

    fixture.database.webhookEvent.findMany
      .mockResolvedValueOnce([old] as never)
      .mockResolvedValueOnce([]);
    await expect(
      fixture.service.scrubHistorical(TARGET, true)
    ).resolves.toEqual({
      changedEvents: 1,
      changedOrders: 0,
      executed: true,
    });
    expect(fixture.database.webhookEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100, orderBy: { id: 'asc' } })
    );
    expect(fixture.database.webhookEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'evt_a',
        tenantId: TARGET.tenantId,
        storeId: TARGET.storeId,
        status: 'COMPLETED',
      },
      data: {
        payload: expect.not.objectContaining({ meta_data: expect.anything() }),
      },
    });
  });

  it('anonymizes scoped records while preserving audit identity', async () => {
    const fixture = setup();
    fixture.store.status = StoreStatus.DISCONNECTED;
    fixture.store.deletedAt = new Date();
    await fixture.service.erase(TARGET);

    expect(fixture.transaction.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'ten_a', storeId: 'sto_a' },
        data: expect.objectContaining({
          customerSnapshot: {},
          lineItemsSnapshot: [],
        }),
      })
    );
    expect(fixture.transaction.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'ten_a',
          entityId: 'sto_a',
          action: 'privacy.store_erased',
        }),
      })
    );
  });
});
