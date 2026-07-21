import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { TenantContextService } from './tenant-context.service';
import { TenantScopedPrismaService } from './tenant-scoped-prisma.service';

@Module({
  imports: [PrismaModule],
  providers: [TenantContextService, TenantScopedPrismaService],
  exports: [TenantContextService, TenantScopedPrismaService],
})
export class TenantContextModule {}
