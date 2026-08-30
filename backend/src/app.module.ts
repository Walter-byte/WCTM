import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { StructuredLoggingModule } from './common/logging/structured-logging.module';
import { CorrelationIdMiddleware } from './common/request-context/correlation-id.middleware';
import { RequestContextModule } from './common/request-context/request-context.module';
import { ApplicationConfigModule } from './config/application-config.module';
import { HealthModule } from './health/health.module';
import { MembershipsModule } from './memberships/memberships.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { PilotModule } from './pilot/pilot.module';
import { PrismaModule } from './prisma/prisma.module';
import { StoreModule } from './store/store.module';
import { TenantContextGuard } from './tenant/guards/tenant-context.guard';
import { TenantContextModule } from './tenant/tenant-context.module';
import { TelegramModule } from './telegram/telegram.module';
import { TenantsModule } from './tenants/tenants.module';
import { UsersModule } from './users/users.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ApplicationConfigModule,
    RequestContextModule,
    StructuredLoggingModule,
    AuthModule,
    PrismaModule,
    HealthModule,
    TenantContextModule,
    StoreModule,
    UsersModule,
    TenantsModule,
    MembershipsModule,
    OnboardingModule,
    PilotModule,
    WebhooksModule,
    TelegramModule,
  ],
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
