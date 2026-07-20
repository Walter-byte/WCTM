import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

import { ApplicationConfigService } from './application-config.service';
import { validateEnvironment } from './environment.validation';

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      cache: true,
      envFilePath: '../.env',
      expandVariables: false,
      isGlobal: true,
      skipProcessEnv: true,
      validate: validateEnvironment,
    }),
  ],
  providers: [ApplicationConfigService],
  exports: [ApplicationConfigService],
})
export class ApplicationConfigModule {}
