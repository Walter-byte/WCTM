import { describe, expect, it, jest } from '@jest/globals';
import { MembershipRole } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import type { TenantScopedPrismaService } from '../tenant/tenant-scoped-prisma.service';
import { TenantsService } from './tenants.service';

interface TenantCreateArgs {
  data: {
    id: string;
    name: string;
    memberships: {
      create: {
        id: string;
        userId: string;
        role: MembershipRole;
      };
    };
  };
}

describe('TenantsService', () => {
  it('creates a tenant and provisions its creator as OWNER atomically', async () => {
    const create = jest.fn(async ({ data }: TenantCreateArgs) => ({
      id: data.id,
      name: data.name,
      plan: 'FREE',
      createdAt: new Date(),
      updatedAt: new Date(),
      memberships: [data.memberships.create],
    }));
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'usr_creator' } as never),
      },
      tenant: { create },
    } as unknown as PrismaService;
    const service = new TenantsService(prisma, {} as TenantScopedPrismaService);

    const tenant = await service.createTenant(
      { sub: 'usr_creator' },
      { name: 'Creator Tenant' }
    );

    expect(tenant.id).toMatch(/^ten_/);
    expect(tenant.memberships).toHaveLength(1);
    expect(tenant.memberships[0]).toMatchObject({
      userId: 'usr_creator',
      role: MembershipRole.OWNER,
    });
    expect(String(tenant.memberships[0]?.id)).toMatch(/^mem_/);
  });

  it('soft-deletes only the active tenant selected by server context', async () => {
    const softDeleteActiveTenant = jest.fn().mockResolvedValue(true as never);
    const tenantPrisma = {
      softDeleteActiveTenant,
    } as unknown as TenantScopedPrismaService;
    const service = new TenantsService({} as PrismaService, tenantPrisma);

    await expect(service.softDeleteCurrentTenant()).resolves.toBeUndefined();
    expect(softDeleteActiveTenant).toHaveBeenCalledWith(expect.any(Date));
  });
});
