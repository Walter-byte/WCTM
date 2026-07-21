import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { HealthController } from './health.controller';
import { ReadinessService } from './readiness.service';

@Module({
  imports: [PrismaModule, QueueModule],
  controllers: [HealthController],
  providers: [ReadinessService],
})
export class HealthModule {}
