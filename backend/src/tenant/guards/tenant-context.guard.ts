import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { MembershipRole } from '@prisma/client';
import { Reflector } from '@nestjs/core';

import type { JwtPayload } from '../../auth/auth.service';
import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { REQUIRED_MEMBERSHIP_ROLES_KEY } from '../decorators/require-membership.decorator';
import { IS_TENANT_OPTIONAL_KEY } from '../decorators/tenant-optional.decorator';
import { TenantContextService } from '../tenant-context.service';

interface AuthenticatedRequest {
  user?: JwtPayload;
}

@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const isTenantOptional = this.reflector.getAllAndOverride<boolean>(
      IS_TENANT_OPTIONAL_KEY,
      [context.getHandler(), context.getClass()]
    );

    if (isTenantOptional) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = this.requiredClaim(request.user, 'sub');
    const tenantId = this.requiredClaim(request.user, 'tenantId');
    const membership = await this.prisma.membership.findFirst({
      where: {
        tenantId,
        userId,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: {
        tenantId: true,
        userId: true,
        role: true,
      },
    });

    if (!membership) {
      throw new ForbiddenException('Active tenant membership is required');
    }

    const requiredRoles =
      this.reflector.getAllAndOverride<readonly MembershipRole[]>(
        REQUIRED_MEMBERSHIP_ROLES_KEY,
        [context.getHandler(), context.getClass()]
      ) ?? [];

    if (requiredRoles.length > 0 && !requiredRoles.includes(membership.role)) {
      throw new ForbiddenException('Membership role is not permitted');
    }

    this.tenantContext.set({
      tenantId: membership.tenantId,
      userId: membership.userId,
      membershipRole: membership.role,
    });

    return true;
  }

  private requiredClaim(
    payload: JwtPayload | undefined,
    claim: 'sub' | 'tenantId'
  ): string {
    const value = payload?.[claim];

    if (typeof value !== 'string' || value.trim() === '') {
      throw new ForbiddenException(`JWT ${claim} claim is required`);
    }

    return value;
  }
}
