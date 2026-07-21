import { Module } from '@nestjs/common';

import { TenantContextModule } from '../tenant/tenant-context.module';
import { MembershipsController } from './memberships.controller';
import { MembershipsService } from './memberships.service';

@Module({
  imports: [TenantContextModule],
  controllers: [MembershipsController],
  providers: [MembershipsService],
})
export class MembershipsModule {}
