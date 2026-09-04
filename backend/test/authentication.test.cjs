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
const { QueueRuntimeService } = require('../dist/queue/queue-runtime.service');
const {
  TenantContextService,
} = require('../dist/tenant/tenant-context.service');

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

test('AuthService access tokens honor the configured accessTokenTtl', async () => {
  const authService = createAuthService('1h');
  const token = await authService.signAccessToken({
    sub: 'usr_pilot',
    tenantId: 'ten_pilot',
  });
  const payload = await authService.verifyAccessToken(token);

  assert.equal(payload.exp - payload.iat, 3600);
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
  const {
    configureApplicationRouting,
  } = require('../dist/application-routing');
  const { PrismaService } = require('../dist/prisma/prisma.service');
  const originalModuleInit = PrismaService.prototype.onModuleInit;
  const originalModuleDestroy = PrismaService.prototype.onModuleDestroy;

  PrismaService.prototype.onModuleInit = async () => undefined;
  PrismaService.prototype.onModuleDestroy = async () => undefined;

  class AuthTestController {
    protectedRoute(user) {
      return { user, tenant: tenantContextForTest.active };
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
  let tenantContextForTest;

  try {
    application = await NestFactory.create(AuthTestModule, { logger: false });
    configureApplicationRouting(application);
    const prisma = application.get(PrismaService);
    const queueRuntime = application.get(QueueRuntimeService);
    prisma.membership.findFirst = async ({ where }) =>
      where.userId === 'usr_test' && where.tenantId === 'ten_test'
        ? { tenantId: 'ten_test', userId: 'usr_test', role: 'OWNER' }
        : null;
    tenantContextForTest = application.get(TenantContextService);
    await application.listen(0, '127.0.0.1');

    const address = application.getHttpServer().address();
    assert.notEqual(address, null);
    assert.equal(typeof address, 'object');

    const baseUrl = `http://127.0.0.1:${address.port}`;
    const publicResponse = await fetch(`${baseUrl}/api/auth-test/public`);
    assert.equal(publicResponse.status, 200);
    assert.match(
      publicResponse.headers.get('x-request-id'),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    const onboardingResponse = await fetch(`${baseUrl}/onboarding`);
    assert.equal(onboardingResponse.status, 200);
    assert.match(onboardingResponse.headers.get('content-type'), /^text\/html/);
    assert.equal(
      onboardingResponse.headers.get('referrer-policy'),
      'no-referrer'
    );
    assert.equal(onboardingResponse.headers.get('cache-control'), 'no-store');
    assert.equal(
      onboardingResponse.headers.get('x-content-type-options'),
      'nosniff'
    );
    assert.match(
      onboardingResponse.headers.get('content-security-policy'),
      /connect-src 'self'/
    );
    assert.match(
      onboardingResponse.headers.get('content-security-policy'),
      /default-src 'none'/
    );
    assert.match(
      onboardingResponse.headers.get('content-security-policy'),
      /base-uri 'none'/
    );
    assert.match(
      onboardingResponse.headers.get('content-security-policy'),
      /frame-ancestors 'none'/
    );
    assert.match(
      onboardingResponse.headers.get('content-security-policy'),
      /object-src 'none'/
    );
    assert.match(
      onboardingResponse.headers.get('content-security-policy'),
      /form-action 'self'/
    );
    assert.doesNotMatch(
      onboardingResponse.headers.get('content-security-policy'),
      /unsafe-eval/
    );
    assert.equal(onboardingResponse.headers.get('x-frame-options'), 'DENY');
    assert.match(
      onboardingResponse.headers.get('permissions-policy'),
      /camera=\(\)/
    );
    assert.match(
      await onboardingResponse.text(),
      /Connect WooCommerce to Telegram/
    );
    const onboardingScriptResponse = await fetch(
      `${baseUrl}/onboarding/app.js`
    );
    assert.equal(onboardingScriptResponse.status, 200);
    assert.match(
      onboardingScriptResponse.headers.get('content-type'),
      /^text\/javascript/
    );
    assert.equal(
      onboardingScriptResponse.headers.get('referrer-policy'),
      'no-referrer'
    );
    assert.equal(
      onboardingScriptResponse.headers.get('cache-control'),
      'no-store'
    );
    assert.equal(
      onboardingScriptResponse.headers.get('x-content-type-options'),
      'nosniff'
    );
    assert.equal(
      onboardingScriptResponse.headers.get('x-frame-options'),
      'DENY'
    );
    assert.match(
      onboardingScriptResponse.headers.get('permissions-policy'),
      /microphone=\(\)/
    );
    assert.doesNotMatch(
      await onboardingScriptResponse.text(),
      /localStorage|console\./
    );

    const onboardingStylesResponse = await fetch(
      `${baseUrl}/onboarding/styles.css`
    );
    assert.equal(onboardingStylesResponse.status, 200);
    assert.match(
      onboardingStylesResponse.headers.get('content-type'),
      /^text\/css/
    );
    assert.equal(
      onboardingStylesResponse.headers.get('referrer-policy'),
      'no-referrer'
    );
    assert.equal(
      onboardingStylesResponse.headers.get('cache-control'),
      'no-store'
    );
    assert.equal(
      onboardingStylesResponse.headers.get('x-content-type-options'),
      'nosniff'
    );
    assert.equal(
      onboardingStylesResponse.headers.get('x-frame-options'),
      'DENY'
    );
    assert.match(
      onboardingStylesResponse.headers.get('permissions-policy'),
      /geolocation=\(\)/
    );
    assert.match(await onboardingStylesResponse.text(), /\[hidden\]/);

    const prefixedOnboardingResponse = await fetch(`${baseUrl}/api/onboarding`);
    assert.equal(prefixedOnboardingResponse.status, 404);

    const unprefixedApiResponse = await fetch(`${baseUrl}/auth-test/public`);
    assert.equal(unprefixedApiResponse.status, 404);

    const missingResponse = await fetch(`${baseUrl}/api/auth-test/protected`);
    assert.equal(missingResponse.status, 401);
    assert.match(
      missingResponse.headers.get('x-request-id'),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    const invalidRequestId = 'invalid-auth-request';
    const invalidResponse = await fetch(`${baseUrl}/api/auth-test/protected`, {
      headers: {
        Authorization: 'Bearer invalid-token',
        'x-request-id': invalidRequestId,
      },
    });
    assert.equal(invalidResponse.status, 401);
    assert.equal(invalidResponse.headers.get('x-request-id'), invalidRequestId);
    const invalidResponseBody = await invalidResponse.json();
    assert.deepEqual(invalidResponseBody, {
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Unauthorized',
      requestId: invalidRequestId,
    });
    assert.doesNotMatch(
      JSON.stringify(invalidResponseBody),
      new RegExp(JWT_SECRET)
    );

    const authService = application.get(AuthService);
    let registeredUser;
    let registeredPasswordHash;
    queueRuntime.incrementFixedWindow = async () => 1;
    prisma.$queryRaw = async () => [];
    prisma.user.create = async ({ data }) => {
      registeredPasswordHash = data.passwordHash;
      registeredUser = {
        id: data.id,
        email: data.email,
        displayName: null,
        createdAt: new Date('2026-08-28T08:00:00.000Z'),
        updatedAt: new Date('2026-08-28T08:00:00.000Z'),
      };
      return registeredUser;
    };

    const registrationPassword = 'correct horse battery staple';
    const registrationResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: ' Public.User@Example.COM ',
        password: registrationPassword,
      }),
    });
    assert.equal(registrationResponse.status, 201);
    const registrationBody = await registrationResponse.json();
    assert.equal(registrationBody.user.email, 'public.user@example.com');
    assert.match(
      registeredPasswordHash,
      /^\$argon2id\$v=19\$m=19456,p=1,t=2\$/
    );
    assert.doesNotMatch(registeredPasswordHash, /correct horse/);
    assert.doesNotMatch(
      JSON.stringify(registrationBody.user),
      /password|hash/i
    );
    const registrationPayload = await authService.verifyAccessToken(
      registrationBody.accessToken
    );
    assert.equal(registrationPayload.sub, registeredUser.id);
    assert.equal(registrationPayload.tenantId, undefined);
    assert.equal(registrationPayload.passwordHash, undefined);

    prisma.$queryRaw = async () => [
      { ...registeredUser, passwordHash: registeredPasswordHash },
    ];
    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'PUBLIC.USER@example.com',
        password: registrationPassword,
      }),
    });
    assert.equal(loginResponse.status, 200);
    const loginBody = await loginResponse.json();
    assert.equal(
      (await authService.verifyAccessToken(loginBody.accessToken)).sub,
      registeredUser.id
    );
    assert.doesNotMatch(JSON.stringify(loginBody.user), /password|hash/i);

    const wrongPasswordResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: registeredUser.email,
        password: 'incorrect password value',
      }),
    });
    prisma.$queryRaw = async () => [];
    const unknownEmailResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'unknown@example.com',
        password: 'incorrect password value',
      }),
    });
    assert.equal(wrongPasswordResponse.status, 401);
    assert.equal(unknownEmailResponse.status, 401);
    const wrongPasswordBody = await wrongPasswordResponse.json();
    const unknownEmailBody = await unknownEmailResponse.json();
    delete wrongPasswordBody.requestId;
    delete unknownEmailBody.requestId;
    assert.deepEqual(unknownEmailBody, wrongPasswordBody);

    prisma.user.findUnique = async ({ where }) =>
      where.id === registeredUser.id ? registeredUser : null;
    const profileResponse = await fetch(`${baseUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${registrationBody.accessToken}` },
    });
    assert.equal(profileResponse.status, 200);
    assert.equal((await profileResponse.json()).id, registeredUser.id);

    prisma.membership.findMany = async () => [];
    const missingTenantContextResponse = await fetch(
      `${baseUrl}/api/auth/tenant-context`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${registrationBody.accessToken}` },
      }
    );
    assert.equal(missingTenantContextResponse.status, 409);
    assert.match(
      (await missingTenantContextResponse.json()).message,
      /First Tenant bootstrap is required/
    );

    prisma.tenant.create = async ({ data }) => ({
      id: data.id,
      name: data.name,
      plan: 'FREE',
      createdAt: new Date('2026-08-28T08:00:00.000Z'),
      updatedAt: new Date('2026-08-28T08:00:00.000Z'),
      memberships: [data.memberships.create],
    });
    const tenantResponse = await fetch(`${baseUrl}/api/tenants`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${registrationBody.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'First Tenant' }),
    });
    assert.equal(tenantResponse.status, 201);
    const tenantBody = await tenantResponse.json();
    assert.equal(tenantBody.memberships[0].userId, registeredUser.id);
    assert.equal(tenantBody.memberships[0].role, 'OWNER');

    prisma.membership.findMany = async () => [{ tenantId: tenantBody.id }];
    const tenantContextResponse = await fetch(
      `${baseUrl}/api/auth/tenant-context`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${registrationBody.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          tenantId: 'ten_caller_selected',
          storeId: 'sto_caller_selected',
        }),
      }
    );
    assert.equal(tenantContextResponse.status, 200);
    const tenantContextBody = await tenantContextResponse.json();
    assert.deepEqual(Object.keys(tenantContextBody), ['accessToken']);
    const tenantContextPayload = await authService.verifyAccessToken(
      tenantContextBody.accessToken
    );
    assert.equal(tenantContextPayload.sub, registeredUser.id);
    assert.equal(tenantContextPayload.tenantId, tenantBody.id);
    assert.notEqual(tenantContextPayload.tenantId, 'ten_caller_selected');
    assert.equal(tenantContextPayload.storeId, undefined);

    prisma.membership.findMany = async () => [
      { tenantId: tenantBody.id },
      { tenantId: 'ten_second' },
    ];
    const ambiguousTenantContextResponse = await fetch(
      `${baseUrl}/api/auth/tenant-context`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${registrationBody.accessToken}` },
      }
    );
    assert.equal(ambiguousTenantContextResponse.status, 409);

    const noMembershipToken = await authService.signAccessToken({
      sub: 'usr_missing',
      tenantId: 'ten_test',
    });
    const noMembershipResponse = await fetch(
      `${baseUrl}/api/auth-test/protected`,
      {
        headers: { Authorization: `Bearer ${noMembershipToken}` },
      }
    );
    assert.equal(noMembershipResponse.status, 403);

    const token = await authService.signAccessToken({
      sub: 'usr_test',
      tenantId: 'ten_test',
    });
    const validRequestId = 'valid-auth-request';
    const validResponse = await fetch(`${baseUrl}/api/auth-test/protected`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'x-request-id': validRequestId,
      },
    });

    assert.equal(validResponse.status, 200);
    assert.equal(validResponse.headers.get('x-request-id'), validRequestId);
    assert.deepEqual(await validResponse.json(), {
      user: {
        sub: 'usr_test',
        tenantId: 'ten_test',
        iat: (await authService.verifyAccessToken(token)).iat,
        exp: (await authService.verifyAccessToken(token)).exp,
      },
      tenant: {
        tenantId: 'ten_test',
        userId: 'usr_test',
        membershipRole: 'OWNER',
      },
    });
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
