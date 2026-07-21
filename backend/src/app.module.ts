import {
  type MiddlewareConsumer,
  Controller,
  Get,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { AuthModule } from './auth/auth.module';
import { Public } from './auth/decorators/public.decorator';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { StructuredLoggingModule } from './common/logging/structured-logging.module';
import { CorrelationIdMiddleware } from './common/request-context/correlation-id.middleware';
import { RequestContextModule } from './common/request-context/request-context.module';
import { ApplicationConfigModule } from './config/application-config.module';
import { MembershipsModule } from './memberships/memberships.module';
import { PrismaModule } from './prisma/prisma.module';
import { TenantContextGuard } from './tenant/guards/tenant-context.guard';
import { TenantContextModule } from './tenant/tenant-context.module';
import { TenantsModule } from './tenants/tenants.module';
import { UsersModule } from './users/users.module';

@Controller('health')
@Public()
class HealthController {
  @Get()
  getHealth(): { status: string } {
    return { status: 'ok' };
  }
}

@Module({
  imports: [
    ApplicationConfigModule,
    RequestContextModule,
    StructuredLoggingModule,
    AuthModule,
    PrismaModule,
    TenantContextModule,
    UsersModule,
    TenantsModule,
    MembershipsModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: TenantContextGuard,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorrelationIdMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
