import { Module } from '@nestjs/common';

import { TenantContextModule } from '../tenant/tenant-context.module';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [TenantContextModule],
  controllers: [TenantsController],
  providers: [TenantsService],
})
export class TenantsModule {}
