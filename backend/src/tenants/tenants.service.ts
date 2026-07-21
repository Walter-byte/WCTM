import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { MembershipRole, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import type { JwtPayload } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  type TenantSummary,
  TenantScopedPrismaService,
} from '../tenant/tenant-scoped-prisma.service';
import type { CreateTenantDto } from './dto/create-tenant.dto';
import type { UpdateTenantDto } from './dto/update-tenant.dto';

const CREATED_TENANT_SELECT = {
  id: true,
  name: true,
  plan: true,
  createdAt: true,
  updatedAt: true,
  memberships: {
    select: {
      id: true,
      userId: true,
      role: true,
    },
  },
} satisfies Prisma.TenantSelect;

export type CreatedTenant = Prisma.TenantGetPayload<{
  select: typeof CREATED_TENANT_SELECT;
}>;

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantPrisma: TenantScopedPrismaService
  ) {}

  async createTenant(
    payload: JwtPayload | undefined,
    input: CreateTenantDto
  ): Promise<CreatedTenant> {
    const userId = this.authenticatedUserId(payload);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundException('Authenticated user was not found');
    }

    return this.prisma.tenant.create({
      data: {
        id: `ten_${randomUUID()}`,
        name: input.name,
        memberships: {
          create: {
            id: `mem_${randomUUID()}`,
            userId,
            role: MembershipRole.OWNER,
          },
        },
      },
      select: CREATED_TENANT_SELECT,
    });
  }

  async getCurrentTenant(): Promise<TenantSummary> {
    const tenant = await this.tenantPrisma.findActiveTenant();

    if (!tenant) {
      throw new NotFoundException('Tenant was not found');
    }

    return tenant;
  }

  async updateCurrentTenant(input: UpdateTenantDto): Promise<TenantSummary> {
    const updated = await this.tenantPrisma.updateActiveTenantName(input.name);

    if (!updated) {
      throw new NotFoundException('Tenant was not found');
    }

    return this.getCurrentTenant();
  }

  async softDeleteCurrentTenant(): Promise<void> {
    const deleted = await this.tenantPrisma.softDeleteActiveTenant(new Date());

    if (!deleted) {
      throw new NotFoundException('Tenant was not found');
    }
  }

  private authenticatedUserId(payload: JwtPayload | undefined): string {
    const userId = payload?.['sub'];

    if (typeof userId !== 'string' || userId.trim() === '') {
      throw new UnauthorizedException('Authenticated user subject is required');
    }

    return userId;
  }
}
