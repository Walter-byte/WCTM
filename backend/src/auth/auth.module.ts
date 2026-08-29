import { Module } from '@nestjs/common';
import {
  JwtModule,
  type JwtModuleOptions,
  type JwtSignOptions,
} from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { ApplicationConfigModule } from '../config/application-config.module';
import { ApplicationConfigService } from '../config/application-config.service';
import { QueueModule } from '../queue/queue.module';
import { AuthService } from './auth.service';
import { PasswordHashService } from './password-hash.service';
import { PublicAuthController } from './public-auth.controller';
import { PublicAuthRateLimiter } from './public-auth-rate-limiter.service';
import { PublicAuthService } from './public-auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    ApplicationConfigModule,
    QueueModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ApplicationConfigModule],
      inject: [ApplicationConfigService],
      useFactory: (
        configuration: ApplicationConfigService
      ): JwtModuleOptions => ({
        secret: configuration.jwt.secret,
        signOptions: {
          expiresIn: configuration.jwt
            .accessTokenTtl as JwtSignOptions['expiresIn'],
        },
      }),
    }),
  ],
  controllers: [PublicAuthController],
  providers: [
    AuthService,
    JwtStrategy,
    PasswordHashService,
    PublicAuthRateLimiter,
    PublicAuthService,
  ],
  exports: [AuthService],
})
export class AuthModule {}
