import { Module } from '@nestjs/common';

import { StructuredLoggingModule } from '../common/logging/structured-logging.module';
import { ApplicationConfigModule } from '../config/application-config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PilotRetentionService } from './pilot-retention.service';

@Module({
  imports: [PrismaModule, ApplicationConfigModule, StructuredLoggingModule],
  providers: [PilotRetentionService],
})
export class PrivacyRetentionModule {}
