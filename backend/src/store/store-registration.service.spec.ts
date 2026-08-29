import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { StoreStatus } from '@prisma/client';
import { createHash, createHmac } from 'node:crypto';

import type { AuditService } from '../common/audit/audit.service';
import { EncryptionService } from '../common/encryption/encryption.service';
import type { ApplicationConfigService } from '../config/application-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TenantScopedPrismaService } from '../tenant/tenant-scoped-prisma.service';
import type { TenantContextService } from '../tenant/tenant-context.service';
import {
  type WooCommerceConnectionResult,
  WooCommerceClient,
} from '../woocommerce/client/woocommerce.client';
import type { PluginRegistrationRateLimiter } from './plugin-registration-rate-limiter.service';
import { StoreRegistrationService } from './store-registration.service';
import { signaturesMatch } from '../webhooks/woocommerce-webhook-ingestion.service';

interface RegistrationStore {
  id: string;
  tenantId: string;
  baseUrl: string;
  status: StoreStatus;
  consumerKeyEncrypted: string;
  consumerSecretEncrypted: string;
  registrationTokenHash: string | null;
  registrationTokenExpiresAt: Date | null;
  registrationTokenConsumedAt: Date | null;
  pluginSecretHash: string | null;
  pluginRegisteredAt: Date | null;
  lastSeenAt: Date | null;
  lastHealthyAt: Date | null;
  webhookSecretEncrypted: string | null;
  webhookEndpointKey: string | null;
  deletedAt: Date | null;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function setup(
  options: {
    token?: string;
    expiresAt?: Date;
    status?: StoreStatus;
    consumedAt?: Date | null;
    pluginSecretHash?: string | null;
    pluginRegisteredAt?: Date | null;
    webhookSecretEncrypted?: string | null;
    webhookEndpointKey?: string | null;
  } = {}
) {
  const token = options.token ?? `reg_${'t'.repeat(43)}`;
  const configuration = {
    encryption: { key: Buffer.alloc(32, 7).toString('base64') },
    pluginRegistration: {
      tokenTtlSeconds: 900,
      rateLimit: 10,
      rateWindowSeconds: 60,
    },
    woocommerce: {
      rest: {
        maxAttempts: 3,
        attemptTimeoutMs: 5000,
        totalTimeoutMs: 15000,
        backoffBaseMs: 300,
        backoffFactor: 2,
        jitterRatio: 0.2,
      },
    },
  } as ApplicationConfigService;
  const encryption = new EncryptionService(configuration);
  const store: RegistrationStore = {
    id: 'sto_a',
    tenantId: 'ten_a',
    baseUrl: 'https://shop.example',
    status: options.status ?? StoreStatus.PENDING,
    consumerKeyEncrypted: encryption.encrypt('ck_woocommerce'),
    consumerSecretEncrypted: encryption.encrypt('cs_woocommerce'),
    registrationTokenHash: hash(token),
    registrationTokenExpiresAt:
      options.expiresAt ?? new Date(Date.now() + 60_000),
    registrationTokenConsumedAt: options.consumedAt ?? null,
    pluginSecretHash: options.pluginSecretHash ?? null,
    pluginRegisteredAt: options.pluginRegisteredAt ?? null,
    lastSeenAt: null,
    lastHealthyAt: null,
    webhookSecretEncrypted: options.webhookSecretEncrypted ?? null,
    webhookEndpointKey: options.webhookEndpointKey ?? null,
    deletedAt: null,
  };
  const findFirst = jest.fn(
    async ({ where }: { where: Record<string, unknown> }) => {
      const matches =
        store.deletedAt === null &&
        (where['id'] === undefined || store.id === where['id']) &&
        (where['tenantId'] === undefined ||
          store.tenantId === where['tenantId']) &&
        (where['registrationTokenHash'] === undefined ||
          store.registrationTokenHash === where['registrationTokenHash']);

      return matches ? { ...store } : null;
    }
  );
  const findMany = jest.fn(
    async ({ where }: { where: Record<string, unknown> }) =>
      store.deletedAt === null &&
      store.pluginSecretHash !== null &&
      store.pluginSecretHash === where['pluginSecretHash']
        ? [{ ...store }]
        : []
  );
  const updateMany = jest.fn(
    async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: object;
    }) => {
      const expirationFilter = where['registrationTokenExpiresAt'] as
        { gt?: Date } | undefined;
      const webhookFilters = where['OR'] as
        Array<Record<string, unknown>> | undefined;
      const registrationMatches =
        where['registrationTokenHash'] === undefined ||
        (store.registrationTokenHash === where['registrationTokenHash'] &&
          store.registrationTokenConsumedAt === null &&
          (!expirationFilter?.gt ||
            (store.registrationTokenExpiresAt !== null &&
              store.registrationTokenExpiresAt > expirationFilter.gt)));
      const webhookMatches =
        !webhookFilters ||
        webhookFilters.some(
          (filter) =>
            (filter['webhookSecretEncrypted'] === null &&
              store.webhookSecretEncrypted === null) ||
            (filter['webhookSecretEncrypted'] === '' &&
              store.webhookSecretEncrypted === '') ||
            (filter['webhookEndpointKey'] === null &&
              store.webhookEndpointKey === null)
        );
      const matches =
        store.id === where['id'] &&
        (where['tenantId'] === undefined ||
          store.tenantId === where['tenantId']) &&
        (where['pluginSecretHash'] === undefined ||
          store.pluginSecretHash === where['pluginSecretHash']) &&
        registrationMatches &&
        webhookMatches &&
        store.deletedAt === null;

      if (matches) {
        Object.assign(store, data);
      }

      return { count: matches ? 1 : 0 };
    }
  );
  const createAudit = jest.fn().mockResolvedValue({ id: 'aud_1' } as never);
  const transactionClient = {
    store: { findFirst, updateMany },
    auditLog: { create: createAudit },
  };
  const transaction = jest.fn(
    async (callback: (client: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient)
  );
  const prisma = {
    store: { findMany },
    $transaction: transaction,
  } as unknown as PrismaService;
  const issueStoreRegistrationToken = jest.fn(
    async (storeId: string, tokenHash: string, expiresAt: Date) => {
      if (storeId !== store.id || store.deletedAt !== null) {
        return false;
      }

      store.registrationTokenHash = tokenHash;
      store.registrationTokenExpiresAt = expiresAt;
      store.registrationTokenConsumedAt = null;
      return true;
    }
  );
  const findStoreConnectionHealth = jest.fn(async (storeId: string) =>
    storeId === store.id && store.deletedAt === null
      ? {
          status: store.status,
          lastSeenAt: store.lastSeenAt,
          lastHealthyAt: store.lastHealthyAt,
          pluginRegisteredAt: store.pluginRegisteredAt,
        }
      : null
  );
  const tenantPrisma = {
    issueStoreRegistrationToken,
    findStoreConnectionHealth,
  } as unknown as TenantScopedPrismaService;
  const auditRecord = jest.fn().mockResolvedValue(undefined as never);
  const audit = { record: auditRecord } as unknown as AuditService;
  const assertAllowed = jest.fn().mockResolvedValue(undefined as never);
  const rateLimiter = {
    assertAllowed,
  } as unknown as PluginRegistrationRateLimiter;
  const tenantContext = {
    active: {
      tenantId: 'ten_a',
      userId: 'usr_owner',
      membershipRole: 'OWNER',
    },
  } as TenantContextService;
  const testConnection = jest
    .spyOn(WooCommerceClient.prototype, 'testConnection')
    .mockResolvedValue({ success: true });
  const hasRequiredOrderWebhooksForEndpointKey = jest
    .spyOn(
      WooCommerceClient.prototype,
      'hasRequiredOrderWebhooksForEndpointKey'
    )
    .mockResolvedValue(true);
  const service = new StoreRegistrationService(
    prisma,
    tenantPrisma,
    encryption,
    audit,
    configuration,
    rateLimiter,
    tenantContext
  );

  return {
    auditRecord,
    assertAllowed,
    createAudit,
    findFirst,
    findMany,
    hasRequiredOrderWebhooksForEndpointKey,
    issueStoreRegistrationToken,
    service,
    store,
    testConnection,
    token,
    tenantContext,
    transaction,
    updateMany,
  };
}

describe('StoreRegistrationService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('issues a one-time plaintext token for an existing tenant-scoped Store', async () => {
    const fixture = setup({ consumedAt: new Date() });

    const result = await fixture.service.issueToken('sto_a');

    expect(result.token).toMatch(/^reg_[A-Za-z0-9_-]{43}$/);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(fixture.store.registrationTokenHash).toBe(hash(result.token));
    expect(fixture.store.registrationTokenHash).not.toBe(result.token);
    expect(fixture.store.registrationTokenConsumedAt).toBeNull();
    expect(fixture.issueStoreRegistrationToken).toHaveBeenCalledTimes(1);
    expect(fixture.auditRecord).toHaveBeenCalledWith({
      action: 'store.registration_token_issued',
      entity: 'Store',
      entityId: 'sto_a',
    });
    expect(JSON.stringify(result)).not.toMatch(
      /registrationTokenHash|consumerKey|consumerSecret|pluginSecret/i
    );
  });

  it('reissues by replacing the prior unconsumed token without creating a Store', async () => {
    const fixture = setup();
    const firstHash = fixture.store.registrationTokenHash;

    const result = await fixture.service.issueToken('sto_a');

    expect(fixture.store.registrationTokenHash).not.toBe(firstHash);
    expect(fixture.store.registrationTokenHash).toBe(hash(result.token));
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it('returns opaque 404 for an unknown, deleted, or other-tenant Store', async () => {
    const fixture = setup();

    await expect(fixture.service.issueToken('sto_other')).rejects.toThrow(
      NotFoundException
    );
    expect(fixture.auditRecord).not.toHaveBeenCalled();
  });

  it('atomically consumes a valid token and returns one plugin credential', async () => {
    const fixture = setup();

    const result = await fixture.service.register(fixture.token, '203.0.113.5');

    expect(result).toMatchObject({
      pluginCredential: expect.stringMatching(/^plg_[A-Za-z0-9_-]{43}$/),
      storeId: 'sto_a',
    });
    expect(fixture.store.pluginSecretHash).toBe(hash(result.pluginCredential));
    expect(fixture.store.pluginSecretHash).not.toBe(result.pluginCredential);
    expect(fixture.store.registrationTokenConsumedAt).toBeInstanceOf(Date);
    expect(fixture.store.pluginRegisteredAt).toBeInstanceOf(Date);
    expect(fixture.store.lastSeenAt).toBeInstanceOf(Date);
    expect(fixture.store.lastHealthyAt).toBeNull();
    expect(fixture.store.status).toBe(StoreStatus.PENDING);
    expect(result.webhookSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.webhookEndpointKey).toMatch(/^whk_[A-Za-z0-9_-]{43}$/);
    expect(
      new EncryptionService({
        encryption: { key: Buffer.alloc(32, 7).toString('base64') },
      } as ApplicationConfigService).decrypt(
        String(fixture.store.webhookSecretEncrypted)
      )
    ).toBe(result.webhookSecret);
    expect(fixture.createAudit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(
      /registrationToken|pluginSecretHash|consumer|woocommerce/i
    );
  });

  it('rejects replay generically without returning or rotating a credential', async () => {
    const fixture = setup();
    const first = await fixture.service.register(fixture.token, '203.0.113.5');
    const pluginHash = fixture.store.pluginSecretHash;

    await expect(
      fixture.service.register(fixture.token, '203.0.113.5')
    ).rejects.toMatchObject({
      message: 'Plugin registration is invalid or already completed',
    });
    expect(fixture.store.pluginSecretHash).toBe(pluginHash);
    expect(fixture.testConnection).toHaveBeenCalledTimes(1);
    expect(first.pluginCredential).not.toBe(fixture.store.pluginSecretHash);
  });

  it('does not re-expose existing webhook credentials during re-registration', async () => {
    const configuration = {
      encryption: { key: Buffer.alloc(32, 7).toString('base64') },
    } as ApplicationConfigService;
    const encryption = new EncryptionService(configuration);
    const fixture = setup({
      webhookSecretEncrypted: encryption.encrypt('existing-webhook-secret'),
      webhookEndpointKey: `whk_${'e'.repeat(43)}`,
    });

    const result = await fixture.service.register(fixture.token, '203.0.113.5');

    expect(result).not.toHaveProperty('webhookSecret');
    expect(result).not.toHaveProperty('webhookEndpointKey');
    expect(fixture.store.webhookEndpointKey).toBe(`whk_${'e'.repeat(43)}`);
  });

  it('rejects an expired token with the same generic failure', async () => {
    const fixture = setup({ expiresAt: new Date(Date.now() - 1) });

    await expect(
      fixture.service.register(fixture.token, '203.0.113.5')
    ).rejects.toMatchObject({
      message: 'Plugin registration is invalid or already completed',
    });
    expect(fixture.testConnection).not.toHaveBeenCalled();
    expect(fixture.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an unknown token without disclosing token or Store state', async () => {
    const fixture = setup();
    const unknownToken = `reg_${'u'.repeat(43)}`;

    let captured: unknown;
    try {
      await fixture.service.register(unknownToken, '203.0.113.5');
    } catch (error: unknown) {
      captured = error;
    }

    expect(captured).toMatchObject({
      message: 'Plugin registration is invalid or already completed',
    });
    expect(JSON.stringify(captured)).not.toContain(unknownToken);
    expect(JSON.stringify(captured)).not.toContain('sto_a');
    expect(fixture.testConnection).not.toHaveBeenCalled();
  });

  it('fails fast on WooCommerce auth failure without consuming or rotating', async () => {
    const fixture = setup({
      pluginSecretHash: hash('existing_plugin_credential'),
      pluginRegisteredAt: new Date('2026-07-22T10:00:00.000Z'),
    });
    const before = { ...fixture.store };
    fixture.testConnection.mockResolvedValue({
      success: false,
      error: 'WooCommerce authentication failed',
      category: 'auth',
    });

    await expect(
      fixture.service.register(fixture.token, '203.0.113.5')
    ).rejects.toMatchObject({
      message: 'Plugin registration could not be verified',
    });
    expect(fixture.store).toEqual(before);
    expect(fixture.updateMany).not.toHaveBeenCalled();
  });

  it.each(['transport', 'timeout', 'rate-limited'] as const)(
    'returns retryable 503 for %s failure with no partial state',
    async (category) => {
      const fixture = setup({
        status: StoreStatus.ACTIVE,
        pluginSecretHash: hash('existing_plugin_credential'),
        pluginRegisteredAt: new Date('2026-07-22T10:00:00.000Z'),
      });
      const before = { ...fixture.store };
      fixture.testConnection.mockResolvedValue({
        success: false,
        error: 'Generic safe failure',
        category,
      });

      await expect(
        fixture.service.register(fixture.token, '203.0.113.5')
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(fixture.store).toEqual(before);
      expect(fixture.store.status).toBe(StoreStatus.ACTIVE);
      expect(fixture.updateMany).not.toHaveBeenCalled();
    }
  );

  it('allows exactly one concurrent finalization without duplicate rotation', async () => {
    const fixture = setup();

    const results = await Promise.allSettled([
      fixture.service.register(fixture.token, '203.0.113.5'),
      fixture.service.register(fixture.token, '203.0.113.5'),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fixture.store.status).toBe(StoreStatus.PENDING);
    expect(fixture.store.pluginSecretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.createAudit).toHaveBeenCalledTimes(1);
  });

  it('returns tenant-scoped connection health without secret fields', async () => {
    const registeredAt = new Date('2026-07-22T10:00:00.000Z');
    const fixture = setup({ pluginRegisteredAt: registeredAt });
    fixture.store.lastSeenAt = new Date('2026-07-22T10:01:00.000Z');
    fixture.store.lastHealthyAt = new Date('2026-07-22T10:02:00.000Z');

    const health = await fixture.service.connectionHealth('sto_a');

    expect(health).toEqual({
      status: StoreStatus.PENDING,
      lastSeenAt: fixture.store.lastSeenAt,
      lastHealthyAt: fixture.store.lastHealthyAt,
      registered: true,
    });
    expect(JSON.stringify(health)).not.toMatch(
      /token|secret|consumer|credential/i
    );
  });

  it('promotes a registered Store only after required order webhooks verify', async () => {
    const fixture = setup();
    const registration = await fixture.service.register(
      fixture.token,
      '203.0.113.5'
    );

    const result = await fixture.service.confirmPluginConnection(
      registration.pluginCredential
    );

    expect(result).toEqual({ status: StoreStatus.ACTIVE, healthy: true });
    expect(fixture.hasRequiredOrderWebhooksForEndpointKey).toHaveBeenCalledWith(
      registration.webhookEndpointKey
    );
    expect(fixture.store.status).toBe(StoreStatus.ACTIVE);
    expect(fixture.store.lastHealthyAt).toBeInstanceOf(Date);
    expect(fixture.store.lastSeenAt).toBeInstanceOf(Date);
    expect(fixture.createAudit).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toMatch(/secret|credential|token/i);
  });

  it('keeps registration PENDING when required webhooks cannot be verified', async () => {
    const fixture = setup();
    const registration = await fixture.service.register(
      fixture.token,
      '203.0.113.5'
    );
    fixture.hasRequiredOrderWebhooksForEndpointKey.mockResolvedValue(false);

    await expect(
      fixture.service.confirmPluginConnection(registration.pluginCredential)
    ).rejects.toMatchObject({
      status: 400,
      message: 'Required WooCommerce webhooks could not be verified',
    });
    expect(fixture.store.status).toBe(StoreStatus.PENDING);
    expect(fixture.store.lastHealthyAt).toBeNull();
  });

  it('returns opaque 404 for unavailable connection health', async () => {
    const fixture = setup();

    await expect(fixture.service.connectionHealth('sto_other')).rejects.toThrow(
      NotFoundException
    );
  });

  it('provisions missing webhook credentials once without re-exposing the secret', async () => {
    const fixture = setup();

    const first = await fixture.service.provisionWebhookCredentials(
      'sto_a',
      false
    );
    const second = await fixture.service.provisionWebhookCredentials(
      'sto_a',
      false
    );

    expect(first).toMatchObject({
      provisioned: true,
      rotated: false,
      webhookEndpointKey: expect.stringMatching(/^whk_[A-Za-z0-9_-]{43}$/),
      webhookSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(second).toEqual({
      provisioned: true,
      rotated: false,
      webhookEndpointKey: first.webhookEndpointKey,
    });
    expect(second).not.toHaveProperty('webhookSecret');
    expect(fixture.createAudit).toHaveBeenCalledTimes(1);
  });

  it('rotates both webhook values and invalidates the old secret immediately', async () => {
    const encryption = new EncryptionService({
      encryption: { key: Buffer.alloc(32, 7).toString('base64') },
    } as ApplicationConfigService);
    const oldSecret = 'old-webhook-secret';
    const oldEndpointKey = `whk_${'o'.repeat(43)}`;
    const fixture = setup({
      webhookSecretEncrypted: encryption.encrypt(oldSecret),
      webhookEndpointKey: oldEndpointKey,
    });

    const rotated = await fixture.service.provisionWebhookCredentials(
      'sto_a',
      true
    );
    const currentSecret = encryption.decrypt(
      String(fixture.store.webhookSecretEncrypted)
    );

    expect(rotated.rotated).toBe(true);
    expect(rotated.webhookEndpointKey).not.toBe(oldEndpointKey);
    expect(rotated.webhookSecret).toBe(currentSecret);
    expect(currentSecret).not.toBe(oldSecret);
    const body = Buffer.from('{"id":1}');
    const oldSignature = createHmac('sha256', oldSecret).update(body).digest();
    expect(signaturesMatch(body, currentSecret, oldSignature)).toBe(false);
  });

  it('does not provision webhook credentials across tenant boundaries', async () => {
    const fixture = setup();
    Object.assign(fixture.tenantContext.active, { tenantId: 'ten_other' });

    await expect(
      fixture.service.provisionWebhookCredentials('sto_a', false)
    ).rejects.toThrow(NotFoundException);
    expect(fixture.createAudit).not.toHaveBeenCalled();
  });

  it('uses only the token-derived Store mapping during finalization', async () => {
    const fixture = setup();

    await fixture.service.register(fixture.token, '203.0.113.5');

    expect(fixture.findFirst).toHaveBeenCalledWith({
      where: {
        registrationTokenHash: hash(fixture.token),
        deletedAt: null,
      },
      select: expect.objectContaining({ id: true, tenantId: true }),
    });
    expect(fixture.assertAllowed).toHaveBeenCalledWith(
      '203.0.113.5',
      hash(fixture.token)
    );
  });

  it('does not retain raw Axios/WooCommerce errors in registration responses', async () => {
    const fixture = setup();
    const unsafe: WooCommerceConnectionResult = {
      success: false,
      error:
        'authorization=Basic-secret consumerKey=ck_woocommerce consumerSecret=cs_woocommerce',
      category: 'auth',
    };
    fixture.testConnection.mockResolvedValue(unsafe);

    let captured: unknown;
    try {
      await fixture.service.register(fixture.token, '203.0.113.5');
    } catch (error: unknown) {
      captured = error;
    }

    expect(JSON.stringify(captured)).not.toMatch(
      /Basic-secret|ck_woocommerce|cs_woocommerce/
    );
  });
});
