import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { TenantContextModule } from '../../tenant/tenant-context.module';
import { AuditService } from './audit.service';

@Module({
  imports: [PrismaModule, TenantContextModule],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
