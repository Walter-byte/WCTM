import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { ApplicationConfigService } from './config/application-config.service';

async function bootstrap(): Promise<void> {
  const application = await NestFactory.create(AppModule);
  const configuration = application.get(ApplicationConfigService);
  const { port } = configuration.app;

  application.setGlobalPrefix('api');
  application.enableShutdownHooks();

  await application.listen(port, '0.0.0.0');
  Logger.log(`NestJS application started on port ${port}`, 'Bootstrap');
}

void bootstrap().catch((error: unknown) => {
  Logger.error('NestJS application failed to start', error, 'Bootstrap');
  process.exitCode = 1;
});
