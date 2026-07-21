import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { StructuredLoggerService } from './common/logging/structured-logger.service';
import { redactSensitiveData } from './common/utils/redact-sensitive-data';
import { ApplicationConfigService } from './config/application-config.service';
import { ConfigurationValidationError } from './config/environment.validation';

async function bootstrap(): Promise<void> {
  const application = await NestFactory.create(AppModule, { bufferLogs: true });
  const configuration = application.get(ApplicationConfigService);
  const logger = application.get(StructuredLoggerService);
  const { port } = configuration.app;

  application.useLogger(logger);
  application.flushLogs();
  application.setGlobalPrefix('api');
  application.enableShutdownHooks();

  await application.listen(port, '0.0.0.0');
  logger.log('NestJS application started', { port }, 'Bootstrap');
}

void bootstrap().catch((error: unknown) => {
  const detail =
    error instanceof ConfigurationValidationError
      ? error.message
      : error instanceof Error
        ? error.name
        : 'Unknown startup error';

  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      requestId: null,
      context: 'Bootstrap',
      message: 'NestJS application failed to start',
      detail: redactSensitiveData(detail),
    })}\n`
  );
  process.exitCode = 1;
});
