import { Controller, Get, Module } from '@nestjs/common';

import { PrismaModule } from './prisma/prisma.module';

@Controller('health')
class HealthController {
  @Get()
  getHealth(): { status: string } {
    return { status: 'ok' };
  }
}

@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
})
export class AppModule {}
