import { describe, expect, it, jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { StoreStatus } from '@prisma/client';

import type { AuditService } from '../common/audit/audit.service';
import { EncryptionService } from '../common/encryption/encryption.service';
import { RequestContextService } from '../common/request-context/request-context.service';
import type { ApplicationConfigService } from '../config/application-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenant/tenant-context.service';
import { TenantScopedPrismaService } from '../tenant/tenant-scoped-prisma.service';
import { WooCommerceClient } from '../woocommerce/client/woocommerce.client';
import { StoreService } from './store.service';

interface StoredStore {
  id: string;
  tenantId: string;
  name: string;
  baseUrl: string;
  status: StoreStatus;
  consumerKeyEncrypted: string;
  consumerSecretEncrypted: string;
  webhookSecretEncrypted: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface StoreWhere {
  id?: string;
  tenantId?: string;
  deletedAt?: Date | null;
}

function matches(store: StoredStore, where: StoreWhere): boolean {
  return (
    (where.id === undefined || store.id === where.id) &&
    (where.tenantId === undefined || store.tenantId === where.tenantId) &&
    (where.deletedAt === undefined || store.deletedAt === where.deletedAt)
  );
}

function selectStore(
  store: StoredStore,
  select: Record<string, boolean>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, included]) => included)
      .map(([key]) => [key, store[key as keyof StoredStore]])
  );
}

function storedStore(overrides: Partial<StoredStore> = {}): StoredStore {
  const now = new Date('2026-07-21T12:00:00.000Z');

  return {
    id: 'sto_a',
    tenantId: 'ten_a',
    name: 'Store A',
    baseUrl: 'https://store-a.example',
    status: StoreStatus.ACTIVE,
    consumerKeyEncrypted: 'encrypted-key',
    consumerSecretEncrypted: 'encrypted-secret',
    webhookSecretEncrypted: '',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function setup(initialStores: StoredStore[] = []): {
  auditRecord: ReturnType<typeof jest.fn>;
  stores: StoredStore[];
  encryption: EncryptionService;
  runAsTenant: <T>(tenantId: string, callback: () => Promise<T>) => Promise<T>;
  service: StoreService;
} {
  const stores = [...initialStores];
  const storeDelegate = {
    create: jest.fn(
      async ({
        data,
        select,
      }: {
        data: Omit<StoredStore, 'createdAt' | 'updatedAt' | 'deletedAt'>;
        select: Record<string, boolean>;
      }) => {
        const now = new Date();
        const store: StoredStore = {
          ...data,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        stores.push(store);
        return selectStore(store, select);
      }
    ),
    findMany: jest.fn(
      async ({
        where,
        select,
      }: {
        where: StoreWhere;
        select: Record<string, boolean>;
      }) =>
        stores
          .filter((store) => matches(store, where))
          .map((store) => selectStore(store, select))
    ),
    findFirst: jest.fn(
      async ({
        where,
        select,
      }: {
        where: StoreWhere;
        select: Record<string, boolean>;
      }) => {
        const store = stores.find((candidate) => matches(candidate, where));
        return store ? selectStore(store, select) : null;
      }
    ),
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: StoreWhere;
        data: Partial<StoredStore>;
      }) => {
        const matching = stores.filter((store) => matches(store, where));
        matching.forEach((store) => {
          Object.assign(store, data, { updatedAt: new Date() });
        });
        return { count: matching.length };
      }
    ),
  };
  const prisma = { store: storeDelegate } as unknown as PrismaService;
  const requestContext = new RequestContextService();
  const tenantContext = new TenantContextService(requestContext);
  const tenantPrisma = new TenantScopedPrismaService(prisma, tenantContext);
  const encryption = new EncryptionService({
    encryption: { key: Buffer.alloc(32, 9).toString('base64') },
  } as ApplicationConfigService);
  const auditRecord = jest.fn().mockResolvedValue(undefined as never);
  const audit = {
    record: auditRecord,
  } as unknown as AuditService;
  const service = new StoreService(tenantPrisma, encryption, audit);

  return {
    auditRecord,
    stores,
    encryption,
    service,
    runAsTenant: (tenantId, callback) =>
      requestContext.run(`req-${tenantId}`, () => {
        requestContext.setTenant({
          tenantId,
          userId: `usr-${tenantId}`,
          membershipRole: 'OWNER',
        });
        return callback();
      }),
  };
}

describe('StoreService', () => {
  it('stores encrypted credentials and omits all credentials from create responses', async () => {
    const fixture = setup();
    const created = await fixture.runAsTenant('ten_a', () =>
      fixture.service.create({
        name: 'Shop',
        storeUrl: 'https://shop.example',
        consumerKey: 'ck_plain',
        consumerSecret: 'cs_plain',
      })
    );

    expect(fixture.stores[0]).toMatchObject({
      tenantId: 'ten_a',
      status: StoreStatus.ACTIVE,
      webhookSecretEncrypted: '',
    });
    expect(fixture.stores[0]?.consumerKeyEncrypted).not.toBe('ck_plain');
    expect(fixture.stores[0]?.consumerSecretEncrypted).not.toBe('cs_plain');
    expect(JSON.stringify(created)).not.toMatch(/consumer|credential|plain/i);
    expect(fixture.auditRecord).toHaveBeenCalledWith({
      action: 'store.created',
      entity: 'Store',
      entityId: created.id,
      metadata: { status: StoreStatus.ACTIVE },
    });
  });

  it('lists only active stores in the authenticated tenant', async () => {
    const fixture = setup([
      storedStore({ id: 'sto_active' }),
      storedStore({ id: 'sto_deleted', deletedAt: new Date() }),
      storedStore({ id: 'sto_other', tenantId: 'ten_b' }),
    ]);

    await expect(
      fixture.runAsTenant('ten_a', () => fixture.service.findAll())
    ).resolves.toEqual([expect.objectContaining({ id: 'sto_active' })]);
  });

  it('returns 404 for a missing or soft-deleted store', async () => {
    const fixture = setup([
      storedStore({ id: 'sto_deleted', deletedAt: new Date() }),
    ]);

    await expect(
      fixture.runAsTenant('ten_a', () => fixture.service.findOne('sto_deleted'))
    ).rejects.toThrow(NotFoundException);
    await expect(
      fixture.runAsTenant('ten_a', () => fixture.service.findOne('sto_missing'))
    ).rejects.toThrow(NotFoundException);
  });

  it('re-encrypts changed credentials without exposing them', async () => {
    const fixture = setup();
    await fixture.runAsTenant('ten_a', () =>
      fixture.service.create({
        name: 'Shop',
        storeUrl: 'https://shop.example',
        consumerKey: 'ck_original',
        consumerSecret: 'cs_original',
      })
    );
    const store = fixture.stores[0];
    const previousSecret = store?.consumerSecretEncrypted;
    const updated = await fixture.runAsTenant('ten_a', () =>
      fixture.service.update(store?.id ?? '', {
        consumerSecret: 'cs_updated',
      })
    );

    expect(store?.consumerSecretEncrypted).not.toBe(previousSecret);
    expect(
      fixture.encryption.decrypt(store?.consumerSecretEncrypted ?? '')
    ).toBe('cs_updated');
    expect(JSON.stringify(updated)).not.toContain('cs_updated');
    expect(JSON.stringify(updated)).not.toContain('consumerSecretEncrypted');
  });

  it('soft-deletes once and returns 404 on a second delete', async () => {
    const fixture = setup([storedStore()]);

    await expect(
      fixture.runAsTenant('ten_a', () => fixture.service.softDelete('sto_a'))
    ).resolves.toBeUndefined();
    expect(fixture.stores[0]?.deletedAt).toBeInstanceOf(Date);
    await expect(
      fixture.runAsTenant('ten_a', () => fixture.service.softDelete('sto_a'))
    ).rejects.toThrow(NotFoundException);
  });

  it('returns the successful WooCommerce connection result', async () => {
    const fixture = setup();
    const key = fixture.encryption.encrypt('ck_test');
    const secret = fixture.encryption.encrypt('cs_test');
    fixture.stores.push(
      storedStore({
        consumerKeyEncrypted: key,
        consumerSecretEncrypted: secret,
      })
    );
    const testConnection = jest
      .spyOn(WooCommerceClient.prototype, 'testConnection')
      .mockResolvedValue({ success: true, storeName: 'Test Shop' });

    await expect(
      fixture.runAsTenant('ten_a', () =>
        fixture.service.testConnection('sto_a')
      )
    ).resolves.toEqual({ success: true, storeName: 'Test Shop' });
    expect(fixture.auditRecord).toHaveBeenCalledWith({
      action: 'store.connection_tested',
      entity: 'Store',
      entityId: 'sto_a',
      metadata: { success: true },
    });
    testConnection.mockRestore();
  });

  it('returns the safe WooCommerce connection failure result', async () => {
    const fixture = setup();
    fixture.stores.push(
      storedStore({
        consumerKeyEncrypted: fixture.encryption.encrypt('ck_test'),
        consumerSecretEncrypted: fixture.encryption.encrypt('cs_test'),
      })
    );
    const testConnection = jest
      .spyOn(WooCommerceClient.prototype, 'testConnection')
      .mockResolvedValue({ success: false, error: 'Connection refused' });

    await expect(
      fixture.runAsTenant('ten_a', () =>
        fixture.service.testConnection('sto_a')
      )
    ).resolves.toEqual({ success: false, error: 'Connection refused' });
    testConnection.mockRestore();
  });

  it('returns 404 instead of revealing a cross-tenant store', async () => {
    const fixture = setup([
      storedStore({ id: 'sto_private', tenantId: 'ten_b' }),
    ]);

    await expect(
      fixture.runAsTenant('ten_a', () => fixture.service.findOne('sto_private'))
    ).rejects.toThrow(NotFoundException);
  });
});
