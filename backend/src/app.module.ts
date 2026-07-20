import { Controller, Get, Module } from '@nestjs/common';

import { ApplicationConfigModule } from './config/application-config.module';
import { PrismaModule } from './prisma/prisma.module';

@Controller('health')
class HealthController {
  @Get()
  getHealth(): { status: string } {
    return { status: 'ok' };
  }
}

@Module({
  imports: [ApplicationConfigModule, PrismaModule],
  controllers: [HealthController],
})
export class AppModule {}
