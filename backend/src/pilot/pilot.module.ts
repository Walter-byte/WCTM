import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { EncryptionModule } from '../common/encryption/encryption.module';
import { StoreModule } from '../store/store.module';
import { TelegramModule } from '../telegram/telegram.module';
import { TenantContextModule } from '../tenant/tenant-context.module';
import { PilotService } from './pilot.service';

@Module({
  imports: [
    AuthModule,
    EncryptionModule,
    TenantContextModule,
    StoreModule,
    TelegramModule,
  ],
  providers: [PilotService],
  exports: [PilotService],
})
export class PilotModule {}
