import { describe, expect, it, jest } from '@jest/globals';
import type { StoreStatus } from '@prisma/client';

import { RequestContextService } from '../common/request-context/request-context.service';
import type { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from './tenant-context.service';
import { TenantScopedPrismaService } from './tenant-scoped-prisma.service';

interface FakeStore {
  id: string;
  tenantId: string;
  name: string;
  baseUrl: string;
  status: StoreStatus;
  deletedAt: Date | null;
}

function tenantScopedService(stores: FakeStore[]): {
  requestContext: RequestContextService;
  service: TenantScopedPrismaService;
} {
  const findFirst = jest.fn(
    async ({ where }: { where: Partial<FakeStore> }) => {
      const store = stores.find(
        (candidate) =>
          candidate.id === where.id &&
          candidate.tenantId === where.tenantId &&
          candidate.deletedAt === where.deletedAt
      );

      if (!store) {
        return null;
      }

      return {
        id: store.id,
        tenantId: store.tenantId,
        name: store.name,
        baseUrl: store.baseUrl,
        status: store.status,
      };
    }
  );
  const updateMany = jest.fn(
    async ({
      where,
      data,
    }: {
      where: Partial<FakeStore>;
      data: { name: string };
    }) => {
      const store = stores.find(
        (candidate) =>
          candidate.id === where.id &&
          candidate.tenantId === where.tenantId &&
          candidate.deletedAt === where.deletedAt
      );

      if (!store) {
        return { count: 0 };
      }

      store.name = data.name;
      return { count: 1 };
    }
  );
  const prisma = {
    store: { findFirst, updateMany },
  } as unknown as PrismaService;
  const requestContext = new RequestContextService();
  const context = new TenantContextService(requestContext);

  return {
    requestContext,
    service: new TenantScopedPrismaService(prisma, context),
  };
}

describe('TenantScopedPrismaService', () => {
  it('prevents Tenant A from reading or mutating Tenant B rows', async () => {
    const stores: FakeStore[] = [
      {
        id: 'sto_a',
        tenantId: 'ten_a',
        name: 'Tenant A Store',
        baseUrl: 'https://a.example',
        status: 'ACTIVE',
        deletedAt: null,
      },
      {
        id: 'sto_b',
        tenantId: 'ten_b',
        name: 'Tenant B Store',
        baseUrl: 'https://b.example',
        status: 'ACTIVE',
        deletedAt: null,
      },
    ];
    const { requestContext, service } = tenantScopedService(stores);

    await requestContext.run('req-tenant-a', async () => {
      requestContext.setTenant({
        tenantId: 'ten_a',
        userId: 'usr_a',
        membershipRole: 'owner',
      });

      await expect(service.findStoreById('sto_a')).resolves.toMatchObject({
        id: 'sto_a',
        tenantId: 'ten_a',
      });
      await expect(service.findStoreById('sto_b')).resolves.toBeNull();
      await expect(
        service.updateStoreName('sto_b', 'Compromised')
      ).resolves.toBe(false);
    });

    expect(stores[1]?.name).toBe('Tenant B Store');
  });

  it('rejects tenant-owned access when request tenant context is unset', () => {
    const { service } = tenantScopedService([]);

    expect(() => service.findStoreById('sto_a')).toThrow(
      'Tenant context is not available'
    );
  });
});
