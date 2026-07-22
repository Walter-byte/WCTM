import { Module } from '@nestjs/common';

import { AuditModule } from '../common/audit/audit.module';
import { EncryptionModule } from '../common/encryption/encryption.module';
import { QueueModule } from '../queue/queue.module';
import { TenantContextModule } from '../tenant/tenant-context.module';
import { PluginRegistrationController } from './plugin-registration.controller';
import { PluginRegistrationRateLimiter } from './plugin-registration-rate-limiter.service';
import { StoreController } from './store.controller';
import { StoreRegistrationService } from './store-registration.service';
import { StoreService } from './store.service';

@Module({
  imports: [TenantContextModule, EncryptionModule, AuditModule, QueueModule],
  controllers: [StoreController, PluginRegistrationController],
  providers: [
    StoreService,
    StoreRegistrationService,
    PluginRegistrationRateLimiter,
  ],
})
export class StoreModule {}
