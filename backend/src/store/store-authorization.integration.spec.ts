import { describe, expect, it, jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { MembershipRole } from '@prisma/client';
import { Reflector } from '@nestjs/core';

import { RequestContextService } from '../common/request-context/request-context.service';
import type { PrismaService } from '../prisma/prisma.service';
import { TenantContextGuard } from '../tenant/guards/tenant-context.guard';
import { TenantContextService } from '../tenant/tenant-context.service';
import { StoreController } from './store.controller';

const STORE_ROLE_CASES: Array<
  [(storeId: string) => Promise<unknown>, MembershipRole, boolean]
> = [
  [
    StoreController.prototype.issueRegistrationToken,
    MembershipRole.MEMBER,
    false,
  ],
  [
    StoreController.prototype.issueRegistrationToken,
    MembershipRole.ADMIN,
    true,
  ],
  [
    StoreController.prototype.issueRegistrationToken,
    MembershipRole.OWNER,
    true,
  ],
  [StoreController.prototype.connectionHealth, MembershipRole.MEMBER, true],
];

describe('StoreController authorization', () => {
  it('rejects POST /stores when the active membership role is MEMBER', async () => {
    const requestContext = new RequestContextService();
    const tenantContext = new TenantContextService(requestContext);
    const prisma = {
      membership: {
        findFirst: jest.fn().mockResolvedValue({
          tenantId: 'ten_a',
          userId: 'usr_member',
          role: MembershipRole.MEMBER,
        } as never),
      },
    } as unknown as PrismaService;
    const guard = new TenantContextGuard(
      new Reflector(),
      prisma,
      tenantContext
    );
    const executionContext = {
      getHandler: () => StoreController.prototype.create,
      getClass: () => StoreController,
      switchToHttp: () => ({
        getRequest: () => ({
          user: { sub: 'usr_member', tenantId: 'ten_a' },
        }),
      }),
    } as unknown as ExecutionContext;

    await requestContext.run('req-member-create', async () => {
      await expect(guard.canActivate(executionContext)).rejects.toThrow(
        ForbiddenException
      );
    });
  });

  it.each(STORE_ROLE_CASES)(
    'enforces registration and health role boundaries',
    async (handler, role, allowed) => {
      const requestContext = new RequestContextService();
      const tenantContext = new TenantContextService(requestContext);
      const prisma = {
        membership: {
          findFirst: jest.fn().mockResolvedValue({
            tenantId: 'ten_a',
            userId: 'usr_actor',
            role,
          } as never),
        },
      } as unknown as PrismaService;
      const guard = new TenantContextGuard(
        new Reflector(),
        prisma,
        tenantContext
      );
      const executionContext = {
        getHandler: () => handler,
        getClass: () => StoreController,
        switchToHttp: () => ({
          getRequest: () => ({
            user: { sub: 'usr_actor', tenantId: 'ten_a' },
          }),
        }),
      } as unknown as ExecutionContext;

      await requestContext.run('req-role-boundary', async () => {
        if (allowed) {
          await expect(guard.canActivate(executionContext)).resolves.toBe(true);
        } else {
          await expect(guard.canActivate(executionContext)).rejects.toThrow(
            ForbiddenException
          );
        }
      });
    }
  );
});
