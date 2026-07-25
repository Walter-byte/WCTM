import { describe, expect, it, jest } from '@jest/globals';
import { MembershipRole, StoreStatus } from '@prisma/client';

import type { AuthService } from '../auth/auth.service';
import { EncryptionService } from '../common/encryption/encryption.service';
import { RequestContextService } from '../common/request-context/request-context.service';
import type { ApplicationConfigService } from '../config/application-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StoreRegistrationService } from '../store/store-registration.service';
import type { StoreService } from '../store/store.service';
import { TenantContextService } from '../tenant/tenant-context.service';
import type { TelegramLinkingService } from '../telegram/telegram-linking.service';
import type { TelegramOrderService } from '../telegram/telegram-order.service';
import { WooCommerceClient } from '../woocommerce/client/woocommerce.client';
import { type PilotIdentityInput, PilotService } from './pilot.service';

const IDENTITY: PilotIdentityInput = {
  email: 'pilot@example.com',
  displayName: 'Pilot Owner',
  tenantName: 'Pilot Tenant',
};

interface IdentityDatabase {
  users: Array<{ id: string; email: string; displayName: string }>;
  tenants: Array<{ id: string; name: string; deletedAt: Date | null }>;
  memberships: Array<{
    id: string;
    tenantId: string;
    userId: string;
    role: MembershipRole;
    deletedAt: Date | null;
  }>;
}

function configuration(enabled = true): ApplicationConfigService {
  return {
    pilot: {
      enabled,
      webhookBaseUrl: 'https://pilot.example.com',
      readinessTimeoutSeconds: 1,
    },
    woocommerce: {
      rest: {
        maxAttempts: 1,
        attemptTimeoutMs: 100,
        totalTimeoutMs: 200,
        backoffBaseMs: 0,
        backoffFactor: 1,
        jitterRatio: 0,
      },
    },
  } as ApplicationConfigService;
}

function identityPrisma(
  database: IdentityDatabase,
  failMembershipCreate = false
): PrismaService {
  const transaction = {
    user: {
      findMany: jest.fn(async () => database.users),
      create: jest.fn(
        async ({ data }: { data: IdentityDatabase['users'][0] }) => {
          database.users.push(data);
          return { id: data.id };
        }
      ),
    },
    tenant: {
      findMany: jest.fn(async () => database.tenants),
      create: jest.fn(
        async ({
          data,
        }: {
          data: Omit<IdentityDatabase['tenants'][0], 'deletedAt'>;
        }) => {
          database.tenants.push({ ...data, deletedAt: null });
          return { id: data.id };
        }
      ),
    },
    membership: {
      findMany: jest.fn(async () => database.memberships),
      create: jest.fn(
        async ({
          data,
        }: {
          data: Omit<IdentityDatabase['memberships'][0], 'deletedAt'>;
        }) => {
          if (failMembershipCreate) {
            throw new Error('injected membership failure');
          }
          database.memberships.push({ ...data, deletedAt: null });
          return { id: data.id };
        }
      ),
    },
    auditLog: {
      create: jest.fn(async () => ({ id: 'aud_bootstrap' })),
    },
  };

  return {
    $transaction: jest.fn(
      async (callback: (value: typeof transaction) => unknown) => {
        const snapshot = structuredClone(database);

        try {
          return await callback(transaction);
        } catch (error) {
          database.users.splice(0, database.users.length, ...snapshot.users);
          database.tenants.splice(
            0,
            database.tenants.length,
            ...snapshot.tenants
          );
          database.memberships.splice(
            0,
            database.memberships.length,
            ...snapshot.memberships
          );
          throw error;
        }
      }
    ),
  } as unknown as PrismaService;
}

function serviceFor(
  prisma: PrismaService,
  options: {
    enabled?: boolean;
    auth?: Partial<AuthService>;
    stores?: Partial<StoreService>;
    registration?: Partial<StoreRegistrationService>;
    telegramLinking?: Partial<TelegramLinkingService>;
    telegramOrders?: Partial<TelegramOrderService>;
    encryption?: EncryptionService;
  } = {}
): PilotService {
  const requestContext = new RequestContextService();
  const tenantContext = new TenantContextService(requestContext);

  return new PilotService(
    prisma,
    configuration(options.enabled ?? true),
    (options.auth ?? {}) as AuthService,
    requestContext,
    tenantContext,
    (options.stores ?? {}) as StoreService,
    (options.registration ?? {}) as StoreRegistrationService,
    options.encryption ??
      new EncryptionService({
        encryption: { key: Buffer.alloc(32, 4).toString('base64') },
      } as ApplicationConfigService),
    (options.telegramLinking ?? {}) as TelegramLinkingService,
    (options.telegramOrders ?? {}) as TelegramOrderService
  );
}

describe('PilotService bootstrap and guard', () => {
  it('refuses to run unless private-pilot mode is explicitly enabled', () => {
    const database: IdentityDatabase = {
      users: [],
      tenants: [],
      memberships: [],
    };
    const service = serviceFor(identityPrisma(database), { enabled: false });

    expect(() => service.assertPilotEnvironment()).toThrow(/PILOT_MODE=true/);
  });

  it('rolls back User and Tenant creation when OWNER Membership creation fails', async () => {
    const database: IdentityDatabase = {
      users: [],
      tenants: [],
      memberships: [],
    };
    const service = serviceFor(identityPrisma(database, true));

    await expect(service.bootstrapIdentity(IDENTITY)).rejects.toThrow(
      /injected membership failure/
    );
    expect(database).toEqual({ users: [], tenants: [], memberships: [] });
  });

  it('is idempotent only for the same sole pilot identity', async () => {
    const database: IdentityDatabase = {
      users: [],
      tenants: [],
      memberships: [],
    };
    const service = serviceFor(identityPrisma(database));
    const first = await service.bootstrapIdentity(IDENTITY);
    const second = await service.bootstrapIdentity(IDENTITY);

    expect(first.created).toBe(true);
    expect(second).toEqual({ identity: first.identity, created: false });
    expect(database.users).toHaveLength(1);
    expect(database.tenants).toHaveLength(1);
    expect(database.memberships).toHaveLength(1);
  });

  it('refuses an unrelated existing User/Tenant bootstrap', async () => {
    const database: IdentityDatabase = {
      users: [
        {
          id: 'usr_other',
          email: 'other@example.com',
          displayName: 'Other',
        },
      ],
      tenants: [{ id: 'ten_other', name: 'Other Tenant', deletedAt: null }],
      memberships: [
        {
          id: 'mem_other',
          tenantId: 'ten_other',
          userId: 'usr_other',
          role: MembershipRole.OWNER,
          deletedAt: null,
        },
      ],
    };
    const service = serviceFor(identityPrisma(database));

    await expect(service.bootstrapIdentity(IDENTITY)).rejects.toThrow(
      /unrelated User\/Tenant bootstrap/
    );
  });
});

describe('PilotService setup and readiness', () => {
  it('uses AuthService, validates fail-closed, provisions webhooks, activates one Store, and issues one link token', async () => {
    const encryption = new EncryptionService({
      encryption: { key: Buffer.alloc(32, 7).toString('base64') },
    } as ApplicationConfigService);
    const store = {
      id: 'sto_pilot',
      tenantId: 'ten_pilot',
      baseUrl: 'https://shop.example.com',
      status: StoreStatus.PENDING as StoreStatus,
      consumerKeyEncrypted: encryption.encrypt('ck_private'),
      consumerSecretEncrypted: encryption.encrypt('cs_private'),
      webhookSecretEncrypted: null as string | null,
      webhookEndpointKey: null as string | null,
      deletedAt: null,
    };
    const auditCreate = jest.fn(async () => ({ id: 'aud_pilot' }));
    const prisma = {
      store: {
        findMany: jest.fn(async () => [store]),
        findFirst: jest.fn(async () => store),
      },
      telegramAccount: {
        findUnique: jest.fn(async () => null),
      },
      $transaction: jest.fn(
        async (callback: (transaction: unknown) => unknown) =>
          callback({
            store: {
              findFirst: jest.fn(async () => ({ status: store.status })),
              updateMany: jest.fn(async () => {
                store.status = StoreStatus.ACTIVE;
                return { count: 1 };
              }),
            },
            auditLog: { create: auditCreate },
          })
      ),
    } as unknown as PrismaService;
    const signAccessToken = jest.fn(async () => 'jwt_value_never_printed');
    const verifyAccessToken = jest.fn(async () => ({
      sub: 'usr_pilot',
      tenantId: 'ten_pilot',
      iat: 1,
      exp: 901,
    }));
    const issueToken = jest.fn(async () => ({
      token: 'tgl_one_time_value',
      expiresAt: new Date(),
    }));
    const provisionWebhookCredentials = jest.fn(async () => {
      store.webhookSecretEncrypted = encryption.encrypt('webhook_private');
      store.webhookEndpointKey = 'whk_private_endpoint';
      return {
        provisioned: true as const,
        rotated: false,
        webhookEndpointKey: store.webhookEndpointKey,
        webhookSecret: 'webhook_private',
      };
    });
    const validate = jest
      .spyOn(WooCommerceClient.prototype, 'validateCredentials')
      .mockResolvedValue({});
    const ensure = jest
      .spyOn(WooCommerceClient.prototype, 'ensureRequiredOrderWebhooks')
      .mockResolvedValue();
    const service = serviceFor(prisma, {
      encryption,
      auth: { signAccessToken, verifyAccessToken },
      registration: { provisionWebhookCredentials },
      telegramLinking: { issueToken },
    });

    const result = await service.setup({
      identity: { userId: 'usr_pilot', tenantId: 'ten_pilot' },
      created: true,
    });

    expect(signAccessToken).toHaveBeenCalledWith({
      sub: 'usr_pilot',
      tenantId: 'ten_pilot',
    });
    expect(verifyAccessToken).toHaveBeenCalledWith('jwt_value_never_printed');
    expect(validate).toHaveBeenCalled();
    expect(provisionWebhookCredentials).toHaveBeenCalledWith(
      'sto_pilot',
      false
    );
    expect(ensure).toHaveBeenCalledWith(
      'https://pilot.example.com/api/webhooks/woocommerce/whk_private_endpoint',
      'webhook_private'
    );
    expect(store.status).toBe(StoreStatus.ACTIVE);
    expect(issueToken).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'usr_pilot', exp: 901 })
    );
    expect(result.startCommand).toBe('/start tgl_one_time_value');
    expect(JSON.stringify(auditCreate.mock.calls)).not.toMatch(
      /ck_|cs_|jwt_value|tgl_|webhook_private|\/start/
    );
    jest.restoreAllMocks();
  });

  it('leaves a PENDING Store non-active when live validation fails', async () => {
    const encryption = new EncryptionService({
      encryption: { key: Buffer.alloc(32, 8).toString('base64') },
    } as ApplicationConfigService);
    const store = {
      id: 'sto_pending',
      tenantId: 'ten_pilot',
      baseUrl: 'https://shop.example.com',
      status: StoreStatus.PENDING,
      consumerKeyEncrypted: encryption.encrypt('ck_private'),
      consumerSecretEncrypted: encryption.encrypt('cs_private'),
      webhookSecretEncrypted: null,
      webhookEndpointKey: null,
      deletedAt: null,
    };
    const registration = jest.fn(async (...arguments_: [string, boolean]) => {
      void arguments_;
      return {
        provisioned: true as const,
        rotated: false,
        webhookEndpointKey: 'unused',
      };
    });
    const prisma = {
      store: {
        findMany: jest.fn(async () => [store]),
      },
    } as unknown as PrismaService;
    jest
      .spyOn(WooCommerceClient.prototype, 'validateCredentials')
      .mockRejectedValue(new Error('safe validation failure'));
    const service = serviceFor(prisma, {
      encryption,
      auth: {
        signAccessToken: jest.fn(async () => 'jwt'),
        verifyAccessToken: jest.fn(async () => ({
          sub: 'usr_pilot',
          tenantId: 'ten_pilot',
        })),
      },
      registration: { provisionWebhookCredentials: registration },
    });

    await expect(
      service.setup({
        identity: { userId: 'usr_pilot', tenantId: 'ten_pilot' },
        created: false,
      })
    ).rejects.toThrow(/safe validation failure/);
    expect(store.status).toBe(StoreStatus.PENDING);
    expect(registration).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it.each([StoreStatus.PENDING, StoreStatus.DISCONNECTED])(
    'reports %s Store, missing Telegram link, and missing order as readiness failures',
    async (storeStatus) => {
      const prisma = {
        user: { findMany: jest.fn(async () => [{ id: 'usr_pilot' }]) },
        tenant: {
          findMany: jest.fn(async () => [{ id: 'ten_pilot', deletedAt: null }]),
        },
        membership: {
          findMany: jest.fn(async () => [
            {
              tenantId: 'ten_pilot',
              userId: 'usr_pilot',
              role: MembershipRole.OWNER,
              deletedAt: null,
            },
          ]),
        },
        store: {
          findMany: jest.fn(async () => [
            {
              id: 'sto_pending',
              tenantId: 'ten_pilot',
              baseUrl: 'https://shop.example.com',
              status: storeStatus,
              consumerKeyEncrypted: 'encrypted',
              consumerSecretEncrypted: 'encrypted',
              webhookSecretEncrypted: null,
              webhookEndpointKey: null,
              deletedAt: null,
            },
          ]),
        },
      } as unknown as PrismaService;
      const service = serviceFor(prisma);
      const checks = await service.readiness();

      expect(checks).toHaveLength(9);
      expect(checks.find((check) => check.key === 'activeStore')?.pass).toBe(
        false
      );
      expect(checks.find((check) => check.key === 'telegram')?.pass).toBe(
        false
      );
      expect(checks.find((check) => check.key === 'projectedOrder')?.pass).toBe(
        false
      );
      expect(
        checks.find((check) => check.key === 'telegramOrderFlow')?.pass
      ).toBe(false);
    }
  );
});
