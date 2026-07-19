import 'reflect-metadata';

import { Controller, Get, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

@Controller('health')
class HealthController {
  @Get()
  getHealth(): { status: string } {
    return { status: 'ok' };
  }
}

// Phase 1 keeps the application module local; feature modules will replace it.
@Module({
  controllers: [HealthController],
})
class AppModule {}

async function bootstrap(): Promise<void> {
  const application = await NestFactory.create(AppModule);
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  application.setGlobalPrefix('api');
  application.enableShutdownHooks();

  await application.listen(port, '0.0.0.0');
  Logger.log(`NestJS application started on port ${port}`, 'Bootstrap');
}

void bootstrap().catch((error: unknown) => {
  Logger.error('NestJS application failed to start', error, 'Bootstrap');
  process.exitCode = 1;
});
