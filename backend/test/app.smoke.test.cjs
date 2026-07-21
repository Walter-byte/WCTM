const assert = require('node:assert/strict');
const { test } = require('node:test');

test('Nest application boots', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalJwtAccessTtl = process.env.JWT_ACCESS_TTL;
  const originalNodeEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_TTL = '15m';
  process.env.DATABASE_URL =
    originalDatabaseUrl ??
    'postgresql://test:test@localhost:5432/wc_telegram_test';

  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('../dist/app.module');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const originalModuleInit = PrismaService.prototype.onModuleInit;
  const originalModuleDestroy = PrismaService.prototype.onModuleDestroy;

  PrismaService.prototype.onModuleInit = async () => undefined;
  PrismaService.prototype.onModuleDestroy = async () => undefined;

  let application;

  try {
    application = await NestFactory.create(AppModule, { logger: false });
    await application.init();

    assert.equal(application.getHttpAdapter().getType(), 'express');
  } finally {
    if (application) {
      await application.close();
    }

    PrismaService.prototype.onModuleInit = originalModuleInit;
    PrismaService.prototype.onModuleDestroy = originalModuleDestroy;

    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }

    if (originalNodeEnvironment === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnvironment;
    }

    if (originalJwtAccessTtl === undefined) {
      delete process.env.JWT_ACCESS_TTL;
    } else {
      process.env.JWT_ACCESS_TTL = originalJwtAccessTtl;
    }
  }
});
