import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import type { StructuredLoggerService } from '../common/logging/structured-logger.service';
import type { ApplicationConfigService } from '../config/application-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TenantScopedPrismaService } from '../tenant/tenant-scoped-prisma.service';
import { TenantsService } from '../tenants/tenants.service';
import { AuthService } from './auth.service';
import { PasswordHashService } from './password-hash.service';
import type { PublicAuthRateLimiter } from './public-auth-rate-limiter.service';
import { PublicAuthService } from './public-auth.service';

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$hash-value';
const NOW = new Date('2026-08-28T08:00:00.000Z');

const publicUser = {
  id: 'usr_public',
  email: 'user@example.com',
  displayName: null,
  createdAt: NOW,
  updatedAt: NOW,
};

interface Fixture {
  service: PublicAuthService;
  queryRaw: ReturnType<typeof jest.fn>;
  create: ReturnType<typeof jest.fn>;
  hash: ReturnType<typeof jest.fn>;
  matches: ReturnType<typeof jest.fn>;
  signAccessToken: ReturnType<typeof jest.fn>;
  assertRegistrationAllowed: ReturnType<typeof jest.fn>;
  assertLoginAllowed: ReturnType<typeof jest.fn>;
  logger: {
    log: ReturnType<typeof jest.fn>;
    warn: ReturnType<typeof jest.fn>;
  };
}

function fixture(
  credentialUser: Record<string, unknown> | null = null
): Fixture {
  const queryRaw = jest
    .fn()
    .mockResolvedValue((credentialUser ? [credentialUser] : []) as never);
  const create = jest.fn().mockResolvedValue(publicUser as never);
  const hash = jest.fn().mockResolvedValue(PASSWORD_HASH as never);
  const matches = jest.fn().mockResolvedValue(true as never);
  const signAccessToken = jest.fn().mockResolvedValue('jwt-value' as never);
  const assertRegistrationAllowed = jest
    .fn()
    .mockResolvedValue(undefined as never);
  const assertLoginAllowed = jest.fn().mockResolvedValue(undefined as never);
  const logger = { log: jest.fn(), warn: jest.fn() };
  const service = new PublicAuthService(
    {
      $queryRaw: queryRaw,
      user: { create },
    } as unknown as PrismaService,
    { signAccessToken } as unknown as AuthService,
    { hash, matches } as unknown as PasswordHashService,
    {
      assertRegistrationAllowed,
      assertLoginAllowed,
    } as unknown as PublicAuthRateLimiter,
    logger as unknown as StructuredLoggerService
  );

  return {
    service,
    queryRaw,
    create,
    hash,
    matches,
    signAccessToken,
    assertRegistrationAllowed,
    assertLoginAllowed,
    logger,
  };
}

describe('PublicAuthService', () => {
  let realPasswordHashes: PasswordHashService;

  beforeAll(async () => {
    realPasswordHashes = new PasswordHashService();
    await realPasswordHashes.onModuleInit();
  });

  it('registers one normalized User with only an Argon2id hash and a tenantless existing-format JWT', async () => {
    const queryRaw = jest.fn().mockResolvedValue([] as never);
    const create = jest.fn(async ({ data }) => ({
      ...publicUser,
      id: String(data.id),
      email: String(data.email),
    }));
    const configuration = {
      jwt: {
        secret: 'public-auth-test-secret-at-least-32-characters',
        accessTokenTtl: '15m',
      },
    } as ApplicationConfigService;
    const auth = new AuthService(new JwtService(), configuration);
    const logger = { log: jest.fn(), warn: jest.fn() };
    const service = new PublicAuthService(
      {
        $queryRaw: queryRaw,
        user: { create },
      } as unknown as PrismaService,
      auth,
      realPasswordHashes,
      {
        assertRegistrationAllowed: jest
          .fn()
          .mockResolvedValue(undefined as never),
      } as unknown as PublicAuthRateLimiter,
      logger as unknown as StructuredLoggerService
    );

    const result = await service.register(
      { email: ' User@Example.COM ', password: PASSWORD },
      '203.0.113.8'
    );
    const createInput = create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
      select: Record<string, boolean>;
    };
    const persistedHash = String(createInput.data['passwordHash']);
    const payload = await auth.verifyAccessToken(result.accessToken);

    expect(createInput.data).toEqual({
      id: expect.stringMatching(/^usr_/),
      email: 'user@example.com',
      passwordHash: expect.stringMatching(
        /^\$argon2id\$v=19\$m=19456,p=1,t=2\$/
      ),
    });
    expect(createInput.select).not.toHaveProperty('passwordHash');
    expect(persistedHash).not.toContain(PASSWORD);
    expect(result.user.email).toBe('user@example.com');
    expect(payload).toMatchObject({ sub: result.user.id });
    expect(payload).not.toHaveProperty('tenantId');
    expect(payload).not.toHaveProperty('password');
    expect(payload).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(result.user)).not.toMatch(/password|hash/i);
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(PASSWORD);
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(persistedHash);
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(
      'user@example.com'
    );
  });

  it('rejects a normalized duplicate safely before hashing or persistence', async () => {
    const existing = { ...publicUser, passwordHash: null };
    const test = fixture(existing);

    await expect(
      test.service.register(
        { email: ' USER@EXAMPLE.COM ', password: PASSWORD },
        '203.0.113.8'
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(test.assertRegistrationAllowed).toHaveBeenCalledWith(
      '203.0.113.8',
      'user@example.com'
    );
    expect(test.hash).not.toHaveBeenCalled();
    expect(test.create).not.toHaveBeenCalled();
    expect(JSON.stringify(test.logger.warn.mock.calls)).not.toContain(PASSWORD);
    expect(JSON.stringify(test.logger.warn.mock.calls)).not.toContain(
      'user@example.com'
    );
  });

  it('logs in with the normalized identity and excludes the hash from response and JWT input', async () => {
    const test = fixture({ ...publicUser, passwordHash: PASSWORD_HASH });

    const result = await test.service.login(
      { email: ' User@Example.COM ', password: PASSWORD },
      '203.0.113.9'
    );

    expect(test.assertLoginAllowed).toHaveBeenCalledWith(
      '203.0.113.9',
      'user@example.com'
    );
    expect(test.matches).toHaveBeenCalledWith(PASSWORD_HASH, PASSWORD);
    expect(test.signAccessToken).toHaveBeenCalledWith({ sub: 'usr_public' });
    expect(result).toEqual({ accessToken: 'jwt-value', user: publicUser });
    expect(JSON.stringify(result.user)).not.toContain(PASSWORD_HASH);
    expect(JSON.stringify(test.logger.log.mock.calls)).not.toContain(PASSWORD);
    expect(JSON.stringify(test.logger.log.mock.calls)).not.toContain(
      PASSWORD_HASH
    );
  });

  it('returns the same safe failure for an unknown email and a wrong password', async () => {
    const unknown = fixture(null);
    unknown.matches.mockResolvedValue(false as never);
    const wrong = fixture({ ...publicUser, passwordHash: PASSWORD_HASH });
    wrong.matches.mockResolvedValue(false as never);

    const unknownError = await unknown.service
      .login(
        { email: 'unknown@example.com', password: PASSWORD },
        '203.0.113.10'
      )
      .catch((error: unknown) => error);
    const wrongError = await wrong.service
      .login({ email: 'user@example.com', password: PASSWORD }, '203.0.113.10')
      .catch((error: unknown) => error);

    expect(unknownError).toBeInstanceOf(UnauthorizedException);
    expect(wrongError).toBeInstanceOf(UnauthorizedException);
    expect((unknownError as UnauthorizedException).getStatus()).toBe(401);
    expect((wrongError as UnauthorizedException).getStatus()).toBe(401);
    expect((unknownError as UnauthorizedException).getResponse()).toEqual(
      (wrongError as UnauthorizedException).getResponse()
    );
    expect(unknown.matches).toHaveBeenCalledWith(null, PASSWORD);
    expect(wrong.matches).toHaveBeenCalledWith(PASSWORD_HASH, PASSWORD);
  });

  it('keeps existing nullable-hash pilot Users functional but unable to password-login', async () => {
    const pilot = fixture({
      ...publicUser,
      id: 'usr_pilot',
      email: 'pilot@example.com',
      passwordHash: null,
    });
    pilot.matches.mockResolvedValue(false as never);

    await expect(
      pilot.service.login(
        { email: 'pilot@example.com', password: PASSWORD },
        '203.0.113.11'
      )
    ).rejects.toMatchObject({ status: 401 });
    expect(pilot.matches).toHaveBeenCalledWith(null, PASSWORD);
  });

  it('lets the issued tenantless identity use the existing M3 first-Tenant bootstrap unchanged', async () => {
    const configuration = {
      jwt: {
        secret: 'm3-public-auth-test-secret-at-least-32-characters',
        accessTokenTtl: '15m',
      },
    } as ApplicationConfigService;
    const auth = new AuthService(new JwtService(), configuration);
    const token = await auth.signAccessToken({ sub: 'usr_public' });
    const payload = await auth.verifyAccessToken(token);
    const create = jest.fn(async ({ data }) => ({
      id: data.id,
      name: data.name,
      plan: 'FREE',
      createdAt: NOW,
      updatedAt: NOW,
      memberships: [data.memberships.create],
    }));
    const tenants = new TenantsService(
      {
        user: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'usr_public' } as never),
        },
        tenant: { create },
      } as unknown as PrismaService,
      {} as TenantScopedPrismaService
    );

    const tenant = await tenants.createTenant(payload, {
      name: 'First Tenant',
    });

    expect(tenant.memberships[0]).toMatchObject({
      userId: 'usr_public',
      role: 'OWNER',
    });
  });
});
