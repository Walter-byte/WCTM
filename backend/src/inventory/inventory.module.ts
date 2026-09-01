import { Module } from '@nestjs/common';

import { EncryptionModule } from '../common/encryption/encryption.module';
import { InventoryProjectionService } from './inventory-projection.service';

@Module({
  imports: [EncryptionModule],
  providers: [InventoryProjectionService],
  exports: [InventoryProjectionService, EncryptionModule],
})
export class InventoryModule {}
