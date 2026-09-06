import { Module } from '@nestjs/common';

import { EncryptionModule } from '../common/encryption/encryption.module';
import { ApplicationConfigModule } from '../config/application-config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EncryptionKeyRotationService } from './encryption-key-rotation.service';

@Module({
  imports: [ApplicationConfigModule, PrismaModule, EncryptionModule],
  providers: [EncryptionKeyRotationService],
})
export class EncryptionKeyRotationModule {}
