import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { json, raw, urlencoded } from 'express';

import { AppModule } from './app.module';
import { configureApplicationRouting } from './application-routing';
import { StructuredLoggerService } from './common/logging/structured-logger.service';
import { redactSensitiveData } from './common/utils/redact-sensitive-data';
import { ApplicationConfigService } from './config/application-config.service';
import { ConfigurationValidationError } from './config/environment.validation';

interface ExpressApplication {
  set(setting: string, value: unknown): void;
}

const JSON_BODY_LIMIT = '64kb';
const WEBHOOK_BODY_LIMIT = '1mb';

async function bootstrap(): Promise<void> {
  const application = await NestFactory.create(AppModule, {
    bodyParser: false,
    bufferLogs: true,
  });
  const configuration = application.get(ApplicationConfigService);
  const logger = application.get(StructuredLoggerService);
  const { port } = configuration.app;

  application.useLogger(logger);
  application.flushLogs();
  const httpApplication = application
    .getHttpAdapter()
    .getInstance() as ExpressApplication;

  httpApplication.set('trust proxy', 1);
  application.use(
    '/api/webhooks/woocommerce/:endpointKey',
    raw({ type: 'application/json', inflate: false, limit: WEBHOOK_BODY_LIMIT })
  );
  application.use(json({ limit: JSON_BODY_LIMIT }));
  application.use(
    urlencoded({ extended: true, limit: JSON_BODY_LIMIT, parameterLimit: 100 })
  );
  configureApplicationRouting(application);
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
