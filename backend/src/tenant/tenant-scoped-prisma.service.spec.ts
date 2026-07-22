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
  registrationTokenHash?: string | null;
  registrationTokenExpiresAt?: Date | null;
  registrationTokenConsumedAt?: Date | null;
  pluginRegisteredAt?: Date | null;
  lastSeenAt?: Date | null;
  lastHealthyAt?: Date | null;
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

      return { ...store };
    }
  );
  const updateMany = jest.fn(
    async ({
      where,
      data,
    }: {
      where: Partial<FakeStore>;
      data: Partial<FakeStore>;
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

      Object.assign(store, data);
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
        membershipRole: 'OWNER',
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

  it('tenant-scopes registration-token issuance and connection health', async () => {
    const stores: FakeStore[] = [
      {
        id: 'sto_a',
        tenantId: 'ten_a',
        name: 'Tenant A Store',
        baseUrl: 'https://a.example',
        status: 'PENDING',
        deletedAt: null,
        registrationTokenHash: null,
        registrationTokenExpiresAt: null,
        registrationTokenConsumedAt: null,
        pluginRegisteredAt: null,
        lastSeenAt: null,
        lastHealthyAt: null,
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

    await requestContext.run('req-registration-tenant-a', async () => {
      requestContext.setTenant({
        tenantId: 'ten_a',
        userId: 'usr_a',
        membershipRole: 'OWNER',
      });

      await expect(
        service.issueStoreRegistrationToken(
          'sto_b',
          'b'.repeat(64),
          new Date(Date.now() + 60_000)
        )
      ).resolves.toBe(false);
      await expect(
        service.findStoreConnectionHealth('sto_b')
      ).resolves.toBeNull();
      await expect(
        service.issueStoreRegistrationToken(
          'sto_a',
          'a'.repeat(64),
          new Date(Date.now() + 60_000)
        )
      ).resolves.toBe(true);
    });

    expect(stores[0]?.registrationTokenHash).toBe('a'.repeat(64));
    expect(stores[1]?.registrationTokenHash).toBeUndefined();
  });

  it('excludes soft-deleted tenants and their memberships from active queries', async () => {
    const tenant = {
      id: 'ten_a',
      name: 'Tenant A',
      plan: 'FREE',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null as Date | null,
    };
    const membership = {
      id: 'mem_a',
      tenantId: 'ten_a',
      userId: 'usr_a',
      role: 'OWNER',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      user: {
        id: 'usr_a',
        email: 'a@example.com',
        displayName: null,
      },
    };
    const prisma = {
      tenant: {
        findFirst: jest.fn(async () =>
          tenant.deletedAt === null ? tenant : null
        ),
        updateMany: jest.fn(async ({ data }: { data: { deletedAt: Date } }) => {
          if (tenant.deletedAt !== null) {
            return { count: 0 };
          }

          tenant.deletedAt = data.deletedAt;
          return { count: 1 };
        }),
      },
      membership: {
        findMany: jest.fn(async () =>
          tenant.deletedAt === null ? [membership] : []
        ),
      },
    } as unknown as PrismaService;
    const requestContext = new RequestContextService();
    const context = new TenantContextService(requestContext);
    const service = new TenantScopedPrismaService(prisma, context);

    await requestContext.run('req-soft-delete', async () => {
      requestContext.setTenant({
        tenantId: 'ten_a',
        userId: 'usr_a',
        membershipRole: 'OWNER',
      });

      await expect(service.findActiveTenant()).resolves.toMatchObject({
        id: 'ten_a',
      });
      await expect(service.listActiveMemberships()).resolves.toHaveLength(1);
      await expect(service.softDeleteActiveTenant(new Date())).resolves.toBe(
        true
      );
      await expect(service.findActiveTenant()).resolves.toBeNull();
      await expect(service.listActiveMemberships()).resolves.toEqual([]);
    });
  });

  it('excludes soft-deleted memberships while the tenant remains active', async () => {
    const memberships = [
      {
        id: 'mem_active',
        tenantId: 'ten_a',
        userId: 'usr_active',
        role: 'MEMBER',
        deletedAt: null,
      },
      {
        id: 'mem_deleted',
        tenantId: 'ten_a',
        userId: 'usr_deleted',
        role: 'MEMBER',
        deletedAt: new Date(),
      },
    ];
    const findMany = jest.fn(
      async ({
        where,
      }: {
        where: { tenantId: string; deletedAt: Date | null };
      }) =>
        memberships.filter(
          (membership) =>
            membership.tenantId === where.tenantId &&
            membership.deletedAt === where.deletedAt
        )
    );
    const prisma = {
      membership: { findMany },
    } as unknown as PrismaService;
    const requestContext = new RequestContextService();
    const context = new TenantContextService(requestContext);
    const service = new TenantScopedPrismaService(prisma, context);

    await requestContext.run('req-active-memberships', async () => {
      requestContext.setTenant({
        tenantId: 'ten_a',
        userId: 'usr_owner',
        membershipRole: 'OWNER',
      });

      await expect(service.listActiveMemberships()).resolves.toEqual([
        expect.objectContaining({ id: 'mem_active' }),
      ]);
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'ten_a',
          deletedAt: null,
        }),
      })
    );
  });
});
