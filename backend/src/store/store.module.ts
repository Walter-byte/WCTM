import { Module } from '@nestjs/common';

import { EncryptionModule } from '../common/encryption/encryption.module';
import { TenantContextModule } from '../tenant/tenant-context.module';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';

@Module({
  imports: [TenantContextModule, EncryptionModule],
  controllers: [StoreController],
  providers: [StoreService],
})
export class StoreModule {}
