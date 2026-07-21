const assert = require('node:assert/strict');
const { test } = require('node:test');

const { Controller, Get, Module } = require('@nestjs/common');
const { JwtService } = require('@nestjs/jwt');
const { NestFactory } = require('@nestjs/core');

const { AuthService } = require('../dist/auth/auth.service');
const {
  CurrentUser,
} = require('../dist/auth/decorators/current-user.decorator');
const { Public } = require('../dist/auth/decorators/public.decorator');
const { JwtStrategy } = require('../dist/auth/strategies/jwt.strategy');

const JWT_SECRET = 'authentication-test-secret-at-least-32-characters';

const createConfiguration = (accessTokenTtl = '15m') => ({
  jwt: {
    accessTokenTtl,
    secret: JWT_SECRET,
  },
});

const createAuthService = (accessTokenTtl = '15m') =>
  new AuthService(new JwtService(), createConfiguration(accessTokenTtl));

test('AuthService signs and verifies an access-token payload', async () => {
  const authService = createAuthService();
  const token = await authService.signAccessToken({ sub: 'usr_test' });
  const payload = await authService.verifyAccessToken(token);

  assert.equal(payload.sub, 'usr_test');
  assert.equal(typeof payload.iat, 'number');
  assert.equal(typeof payload.exp, 'number');
});

test('AuthService rejects tampered and expired access tokens', async () => {
  const authService = createAuthService();
  const token = await authService.signAccessToken({ sub: 'usr_test' });

  await assert.rejects(
    authService.verifyAccessToken(`${token}tampered`),
    (error) => {
      assert.doesNotMatch(String(error), new RegExp(JWT_SECRET));
      return true;
    }
  );

  const expiringAuthService = createAuthService('1ms');
  const expiredToken = await expiringAuthService.signAccessToken({
    sub: 'usr_test',
  });

  await assert.rejects(
    expiringAuthService.verifyAccessToken(expiredToken),
    /jwt expired/
  );
});

test('JwtStrategy returns the validated payload', () => {
  const strategy = new JwtStrategy(createConfiguration());
  const payload = { sub: 'usr_test' };

  assert.equal(strategy.validate(payload), payload);
});

test('global JWT guard protects routes and Public bypasses authentication', async () => {
  const originalJwtAccessTtl = process.env.JWT_ACCESS_TTL;
  const originalNodeEnvironment = process.env.NODE_ENV;
  process.env.JWT_ACCESS_TTL = '15m';
  process.env.NODE_ENV = 'test';

  const { AppModule } = require('../dist/app.module');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const originalModuleInit = PrismaService.prototype.onModuleInit;
  const originalModuleDestroy = PrismaService.prototype.onModuleDestroy;

  PrismaService.prototype.onModuleInit = async () => undefined;
  PrismaService.prototype.onModuleDestroy = async () => undefined;

  class AuthTestController {
    protectedRoute(user) {
      return user;
    }

    publicRoute() {
      return { status: 'public' };
    }
  }

  Controller('auth-test')(AuthTestController);

  const protectedDescriptor = Object.getOwnPropertyDescriptor(
    AuthTestController.prototype,
    'protectedRoute'
  );
  Get('protected')(
    AuthTestController.prototype,
    'protectedRoute',
    protectedDescriptor
  );
  CurrentUser()(AuthTestController.prototype, 'protectedRoute', 0);

  const publicDescriptor = Object.getOwnPropertyDescriptor(
    AuthTestController.prototype,
    'publicRoute'
  );
  Get('public')(AuthTestController.prototype, 'publicRoute', publicDescriptor);
  Public()(AuthTestController.prototype, 'publicRoute', publicDescriptor);

  class AuthTestModule {}
  Module({ imports: [AppModule], controllers: [AuthTestController] })(
    AuthTestModule
  );

  let application;

  try {
    application = await NestFactory.create(AuthTestModule, { logger: false });
    await application.listen(0, '127.0.0.1');

    const address = application.getHttpServer().address();
    assert.notEqual(address, null);
    assert.equal(typeof address, 'object');

    const baseUrl = `http://127.0.0.1:${address.port}`;
    const publicResponse = await fetch(`${baseUrl}/auth-test/public`);
    assert.equal(publicResponse.status, 200);

    const missingResponse = await fetch(`${baseUrl}/auth-test/protected`);
    assert.equal(missingResponse.status, 401);

    const invalidResponse = await fetch(`${baseUrl}/auth-test/protected`, {
      headers: { Authorization: 'Bearer invalid-token' },
    });
    assert.equal(invalidResponse.status, 401);
    assert.doesNotMatch(await invalidResponse.text(), new RegExp(JWT_SECRET));

    const authService = application.get(AuthService);
    const token = await authService.signAccessToken({ sub: 'usr_test' });
    const validResponse = await fetch(`${baseUrl}/auth-test/protected`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(validResponse.status, 200);
    assert.equal((await validResponse.json()).sub, 'usr_test');
  } finally {
    if (application) {
      await application.close();
    }

    PrismaService.prototype.onModuleInit = originalModuleInit;
    PrismaService.prototype.onModuleDestroy = originalModuleDestroy;

    if (originalJwtAccessTtl === undefined) {
      delete process.env.JWT_ACCESS_TTL;
    } else {
      process.env.JWT_ACCESS_TTL = originalJwtAccessTtl;
    }

    if (originalNodeEnvironment === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnvironment;
    }
  }
});
