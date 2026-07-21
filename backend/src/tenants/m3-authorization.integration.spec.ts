import { describe, expect, it, jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { MembershipRole } from '@prisma/client';
import { Reflector } from '@nestjs/core';

import { RequestContextService } from '../common/request-context/request-context.service';
import type { PrismaService } from '../prisma/prisma.service';
import { TenantContextGuard } from '../tenant/guards/tenant-context.guard';
import { TenantContextService } from '../tenant/tenant-context.service';
import { TenantsController } from './tenants.controller';

function executionContext(
  handler: (...args: never[]) => unknown,
  user: Record<string, unknown>
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => TenantsController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function membershipPrisma(
  membership: { tenantId: string; userId: string; role: MembershipRole } | null
) {
  const findFirst = jest.fn(
    async ({ where }: { where: { tenantId: string; userId: string } }) =>
      membership &&
      membership.tenantId === where.tenantId &&
      membership.userId === where.userId
        ? membership
        : null
  );

  return {
    prisma: { membership: { findFirst } } as unknown as PrismaService,
    findFirst,
  };
}

describe('M3 tenant authorization integration', () => {
  it('uses @RequireMembership metadata to reject a MEMBER from tenant updates', async () => {
    const requestContext = new RequestContextService();
    const tenantContext = new TenantContextService(requestContext);
    const { prisma } = membershipPrisma({
      tenantId: 'ten_a',
      userId: 'usr_member',
      role: MembershipRole.MEMBER,
    });
    const guard = new TenantContextGuard(
      new Reflector(),
      prisma,
      tenantContext
    );

    await requestContext.run('req-role-integration', async () => {
      await expect(
        guard.canActivate(
          executionContext(TenantsController.prototype.updateCurrentTenant, {
            sub: 'usr_member',
            tenantId: 'ten_a',
          })
        )
      ).rejects.toThrow('Membership role is not permitted');
    });
  });

  it('denies Tenant A when the signed request selects Tenant B without membership', async () => {
    const requestContext = new RequestContextService();
    const tenantContext = new TenantContextService(requestContext);
    const { prisma } = membershipPrisma({
      tenantId: 'ten_a',
      userId: 'usr_a',
      role: MembershipRole.OWNER,
    });
    const guard = new TenantContextGuard(
      new Reflector(),
      prisma,
      tenantContext
    );

    await requestContext.run('req-cross-tenant', async () => {
      await expect(
        guard.canActivate(
          executionContext(TenantsController.prototype.getCurrentTenant, {
            sub: 'usr_a',
            tenantId: 'ten_b',
          })
        )
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('keeps tenant creation JWT-protected while bypassing tenant resolution', async () => {
    const requestContext = new RequestContextService();
    const tenantContext = new TenantContextService(requestContext);
    const { prisma, findFirst } = membershipPrisma(null);
    const guard = new TenantContextGuard(
      new Reflector(),
      prisma,
      tenantContext
    );

    await expect(
      guard.canActivate(
        executionContext(TenantsController.prototype.createTenant, {
          sub: 'usr_bootstrap',
        })
      )
    ).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
