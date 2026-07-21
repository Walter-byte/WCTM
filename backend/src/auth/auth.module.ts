import { Module } from '@nestjs/common';
import {
  JwtModule,
  type JwtModuleOptions,
  type JwtSignOptions,
} from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { ApplicationConfigModule } from '../config/application-config.module';
import { ApplicationConfigService } from '../config/application-config.service';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    ApplicationConfigModule,
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
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
