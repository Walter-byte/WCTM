import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from './tenant-context.service';

const STORE_SUMMARY_SELECT = {
  id: true,
  tenantId: true,
  name: true,
  baseUrl: true,
  status: true,
} satisfies Prisma.StoreSelect;

export type TenantScopedStore = Prisma.StoreGetPayload<{
  select: typeof STORE_SUMMARY_SELECT;
}>;

@Injectable()
export class TenantScopedPrismaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService
  ) {}

  findStoreById(storeId: string): Promise<TenantScopedStore | null> {
    return this.prisma.store.findFirst({
      where: {
        id: storeId,
        tenantId: this.tenantContext.active.tenantId,
        deletedAt: null,
      },
      select: STORE_SUMMARY_SELECT,
    });
  }

  async updateStoreName(storeId: string, name: string): Promise<boolean> {
    const result = await this.prisma.store.updateMany({
      where: {
        id: storeId,
        tenantId: this.tenantContext.active.tenantId,
        deletedAt: null,
      },
      data: { name },
    });

    return result.count === 1;
  }
}
