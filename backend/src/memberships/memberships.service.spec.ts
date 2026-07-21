import { describe, expect, it, jest } from '@jest/globals';
import { MembershipRole } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import type { TenantContextService } from '../tenant/tenant-context.service';
import type { TenantScopedPrismaService } from '../tenant/tenant-scoped-prisma.service';
import { MembershipsService } from './memberships.service';

function context(role: MembershipRole): TenantContextService {
  return {
    active: {
      tenantId: 'ten_a',
      userId: 'usr_actor',
      membershipRole: role,
    },
  } as TenantContextService;
}

function transactionPrisma(
  transaction: Record<string, unknown>
): PrismaService {
  return {
    $transaction: jest.fn(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(transaction)
    ),
  } as unknown as PrismaService;
}

describe('MembershipsService', () => {
  it('prevents demoting the last remaining OWNER', async () => {
    const updateMany = jest.fn();
    const transaction = {
      membership: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'mem_owner',
          role: MembershipRole.OWNER,
        } as never),
        count: jest.fn().mockResolvedValue(1 as never),
        updateMany,
      },
    };
    const service = new MembershipsService(
      transactionPrisma(transaction),
      context(MembershipRole.OWNER),
      {} as TenantScopedPrismaService
    );

    await expect(
      service.updateMembershipRole('mem_owner', {
        role: MembershipRole.ADMIN,
      })
    ).rejects.toThrow('last remaining owner');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('prevents removing the last remaining OWNER', async () => {
    const updateMany = jest.fn();
    const transaction = {
      membership: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'mem_owner',
          role: MembershipRole.OWNER,
        } as never),
        count: jest.fn().mockResolvedValue(1 as never),
        updateMany,
      },
    };
    const service = new MembershipsService(
      transactionPrisma(transaction),
      context(MembershipRole.OWNER),
      {} as TenantScopedPrismaService
    );

    await expect(service.removeMembership('mem_owner')).rejects.toThrow(
      'last remaining owner'
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('allows an ADMIN to add a MEMBER but not an OWNER', async () => {
    const membership = {
      id: 'mem_new',
      tenantId: 'ten_a',
      userId: 'usr_new',
      role: MembershipRole.MEMBER,
      createdAt: new Date(),
      updatedAt: new Date(),
      user: {
        id: 'usr_new',
        email: 'new@example.com',
        displayName: null,
      },
    };
    const tenantPrisma = {
      findMembershipRecordByUserId: jest.fn().mockResolvedValue(null as never),
      createMembership: jest.fn().mockResolvedValue({ id: 'mem_new' } as never),
      findActiveMembershipById: jest
        .fn()
        .mockResolvedValue(membership as never),
    } as unknown as TenantScopedPrismaService;
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'usr_new' } as never),
      },
    } as unknown as PrismaService;
    const service = new MembershipsService(
      prisma,
      context(MembershipRole.ADMIN),
      tenantPrisma
    );

    await expect(
      service.addMembership({
        userId: 'usr_new',
        role: MembershipRole.MEMBER,
      })
    ).resolves.toBe(membership);
    await expect(
      service.addMembership({
        userId: 'usr_new',
        role: MembershipRole.OWNER,
      })
    ).rejects.toThrow('Only an owner can assign the owner role');
  });

  it('soft-deletes a tenant-scoped non-owner membership', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 } as never);
    const transaction = {
      membership: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'mem_member',
          role: MembershipRole.MEMBER,
        } as never),
        updateMany,
      },
    };
    const service = new MembershipsService(
      transactionPrisma(transaction),
      context(MembershipRole.ADMIN),
      {} as TenantScopedPrismaService
    );

    await service.removeMembership('mem_member');

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'mem_member',
        tenantId: 'ten_a',
        deletedAt: null,
        role: MembershipRole.MEMBER,
      },
      data: { deletedAt: expect.any(Date) },
    });
  });
});
