import { Module } from '@nestjs/common';

import { EncryptionModule } from '../common/encryption/encryption.module';
import { OrderProjectionService } from './order-projection.service';

@Module({
  imports: [EncryptionModule],
  providers: [OrderProjectionService],
  exports: [OrderProjectionService],
})
export class OrdersModule {}
