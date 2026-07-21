import { Module } from '@nestjs/common';

import { AuditModule } from '../common/audit/audit.module';
import { TenantContextModule } from '../tenant/tenant-context.module';
import { MembershipsController } from './memberships.controller';
import { MembershipsService } from './memberships.service';

@Module({
  imports: [TenantContextModule, AuditModule],
  controllers: [MembershipsController],
  providers: [MembershipsService],
})
export class MembershipsModule {}
