import { Global, Module } from '@nestjs/common';

import { EntitlementService } from './entitlement.service';

@Global()
@Module({
  providers: [EntitlementService],
  exports: [EntitlementService],
})
export class EntitlementsModule {}
