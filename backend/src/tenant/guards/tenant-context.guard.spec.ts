import { describe, expect, it, jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';
import { RequestContextService } from '../../common/request-context/request-context.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { REQUIRED_MEMBERSHIP_ROLES_KEY } from '../decorators/require-membership.decorator';
import { TenantContextService } from '../tenant-context.service';
import { TenantContextGuard } from './tenant-context.guard';

function executionContext(user?: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => executionContext,
    getClass: () => TenantContextGuard,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function reflector(
  isPublic = false,
  requiredRoles: readonly string[] = []
): Reflector {
  return {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === IS_PUBLIC_KEY) {
        return isPublic;
      }

      if (key === REQUIRED_MEMBERSHIP_ROLES_KEY) {
        return requiredRoles;
      }

      return undefined;
    }),
  } as unknown as Reflector;
}

function prismaWithMembership(
  membership: { tenantId: string; userId: string; role: string } | null
): { prisma: PrismaService; findFirst: jest.Mock } {
  const findFirst = jest.fn().mockResolvedValue(membership as never);

  return {
    prisma: { membership: { findFirst } } as unknown as PrismaService,
    findFirst,
  };
}

describe('TenantContextGuard', () => {
  it('resolves the active membership into the existing request context', async () => {
    const requestContext = new RequestContextService();
    const tenantContext = new TenantContextService(requestContext);
    const { prisma, findFirst } = prismaWithMembership({
      tenantId: 'ten_a',
      userId: 'usr_a',
      role: 'owner',
    });
    const guard = new TenantContextGuard(reflector(), prisma, tenantContext);

    await requestContext.run('req-a', async () => {
      await expect(
        guard.canActivate(executionContext({ sub: 'usr_a', tenantId: 'ten_a' }))
      ).resolves.toBe(true);
      expect(tenantContext.active).toEqual({
        tenantId: 'ten_a',
        userId: 'usr_a',
        membershipRole: 'owner',
      });
    });

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'ten_a',
        userId: 'usr_a',
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: { tenantId: true, userId: true, role: true },
    });
  });

  it('rejects an authenticated user without an active membership', async () => {
    const requestContext = new RequestContextService();
    const tenantContext = new TenantContextService(requestContext);
    const { prisma } = prismaWithMembership(null);
    const guard = new TenantContextGuard(reflector(), prisma, tenantContext);

    await requestContext.run('req-no-membership', async () => {
      await expect(
        guard.canActivate(
          executionContext({ sub: 'usr_missing', tenantId: 'ten_a' })
        )
      ).rejects.toThrow('Active tenant membership is required');
      expect(() => tenantContext.active).toThrow(ForbiddenException);
    });
  });

  it('bypasses tenant resolution for Public routes', async () => {
    const requestContext = new RequestContextService();
    const tenantContext = new TenantContextService(requestContext);
    const { prisma, findFirst } = prismaWithMembership(null);
    const guard = new TenantContextGuard(
      reflector(true),
      prisma,
      tenantContext
    );

    await expect(guard.canActivate(executionContext())).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('enforces a declared membership role without a permission matrix', async () => {
    const requestContext = new RequestContextService();
    const tenantContext = new TenantContextService(requestContext);
    const { prisma } = prismaWithMembership({
      tenantId: 'ten_a',
      userId: 'usr_a',
      role: 'viewer',
    });
    const guard = new TenantContextGuard(
      reflector(false, ['owner']),
      prisma,
      tenantContext
    );

    await requestContext.run('req-role', async () => {
      await expect(
        guard.canActivate(executionContext({ sub: 'usr_a', tenantId: 'ten_a' }))
      ).rejects.toThrow('Membership role is not permitted');
    });
  });
});
