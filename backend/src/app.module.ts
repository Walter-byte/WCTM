import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AuthModule } from './auth/auth.module';
import { Public } from './auth/decorators/public.decorator';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { ApplicationConfigModule } from './config/application-config.module';
import { PrismaModule } from './prisma/prisma.module';

@Controller('health')
@Public()
class HealthController {
  @Get()
  getHealth(): { status: string } {
    return { status: 'ok' };
  }
}

@Module({
  imports: [ApplicationConfigModule, AuthModule, PrismaModule],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
