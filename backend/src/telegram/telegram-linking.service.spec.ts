import { describe, expect, it, jest } from '@jest/globals';
import { StoreStatus } from '@prisma/client';
import { createHash } from 'node:crypto';

import type { ApplicationConfigService } from '../config/application-config.service';
import type { EntitlementService } from '../entitlements/entitlement.service';
import type { PrismaService } from '../prisma/prisma.service';
import { TelegramInternalController } from './telegram-internal.controller';
import { TelegramLinkingService } from './telegram-linking.service';
import type { TelegramOrderService } from './telegram-order.service';

interface TokenRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface AccountRow {
  id: string;
  userId: string;
  telegramUserId: bigint;
  lastRedeemUpdateId: bigint | null;
  lastUnlinkUpdateId: bigint | null;
  deletedAt: Date | null;
}

interface ChatRow {
  id: string;
  telegramAccountId: string;
  telegramChatId: bigint;
  revokedAt: Date | null;
  activeTenantId: string | null;
  activeStoreId: string | null;
}

interface StoreRow {
  id: string;
  status: StoreStatus;
  deletedAt: Date | null;
  lastHealthyAt?: Date | null;
  webhookSecretEncrypted?: string | null;
  webhookEndpointKey?: string | null;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function setup() {
  const tokens: TokenRow[] = [];
  const accounts: AccountRow[] = [];
  const chats: ChatRow[] = [];
  const memberships = new Map<string, string[]>();
  const stores = new Map<string, StoreRow[]>();
  const tokenCreate = jest.fn(async ({ data }: { data: TokenRow }) => {
    tokens.push({ ...data, consumedAt: null });
    return { id: data.id };
  });
  const tokenFindUnique = jest.fn(
    async ({ where }: { where: { tokenHash: string } }) =>
      tokens.find((token) => token.tokenHash === where.tokenHash) ?? null
  );
  const tokenUpdateMany = jest.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string; expiresAt: { gt: Date } };
      data: { consumedAt: Date };
    }) => {
      const token = tokens.find(
        (candidate) =>
          candidate.id === where.id &&
          candidate.consumedAt === null &&
          candidate.expiresAt > where.expiresAt.gt
      );

      if (token) {
        token.consumedAt = data.consumedAt;
      }

      return { count: token ? 1 : 0 };
    }
  );
  const accountFindFirst = jest.fn(
    async ({
      where,
    }: {
      where: {
        OR: Array<{ telegramUserId?: bigint; userId?: string }>;
      };
    }) =>
      accounts.find((account) =>
        where.OR.some(
          (filter) =>
            filter.telegramUserId === account.telegramUserId ||
            filter.userId === account.userId
        )
      ) ?? null
  );
  const accountFindUnique = jest.fn(
    async ({
      where,
      select,
    }: {
      where: { telegramUserId?: bigint; userId?: string };
      select?: {
        chatAuthorizations?: { where: { telegramChatId: bigint } };
      };
    }) => {
      const account =
        accounts.find(
          (candidate) =>
            (where.telegramUserId !== undefined &&
              candidate.telegramUserId === where.telegramUserId) ||
            (where.userId !== undefined && candidate.userId === where.userId)
        ) ?? null;

      if (!account) {
        return null;
      }

      return {
        ...account,
        chatAuthorizations: chats
          .filter(
            (chat) =>
              chat.telegramAccountId === account.id &&
              (select?.chatAuthorizations?.where.telegramChatId === undefined ||
                chat.telegramChatId ===
                  select.chatAuthorizations.where.telegramChatId)
          )
          .map((chat) => ({ ...chat })),
      };
    }
  );
  const accountCreate = jest.fn(
    async ({
      data,
    }: {
      data: Omit<AccountRow, 'lastUnlinkUpdateId' | 'deletedAt'>;
    }) => {
      const account: AccountRow = {
        ...data,
        lastUnlinkUpdateId: null,
        deletedAt: null,
      };
      accounts.push(account);
      return { id: account.id };
    }
  );
  const accountUpdate = jest.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<AccountRow>;
    }) => {
      const account = accounts.find((candidate) => candidate.id === where.id)!;
      Object.assign(account, data);
      return { id: account.id };
    }
  );
  const chatFindUnique = jest.fn(
    async ({ where }: { where: { telegramChatId: bigint } }) =>
      chats.find((chat) => chat.telegramChatId === where.telegramChatId) ?? null
  );
  const chatCreate = jest.fn(async ({ data }: { data: ChatRow }) => {
    chats.push({ ...data, revokedAt: null });
    return { id: data.id };
  });
  const chatUpdate = jest.fn(
    async ({
      where,
      data,
    }: {
      where: { telegramChatId: bigint };
      data: Partial<ChatRow>;
    }) => {
      const chat = chats.find(
        (candidate) => candidate.telegramChatId === where.telegramChatId
      )!;
      Object.assign(chat, data);
      return { id: chat.id };
    }
  );
  const chatUpdateMany = jest.fn(
    async ({
      where,
      data,
    }: {
      where: { telegramAccountId: string };
      data: Partial<ChatRow>;
    }) => {
      const matches = chats.filter(
        (chat) =>
          chat.telegramAccountId === where.telegramAccountId &&
          chat.revokedAt === null
      );
      matches.forEach((chat) => Object.assign(chat, data));
      return { count: matches.length };
    }
  );
  const membershipFindMany = jest.fn(
    async ({ where, take }: { where: { userId: string }; take: number }) =>
      (memberships.get(where.userId) ?? [])
        .slice(0, take)
        .map((tenantId) => ({ tenantId }))
  );
  const storeFindMany = jest.fn(
    async ({
      where,
      take,
    }: {
      where: { tenantId: string; status: StoreStatus };
      take: number;
    }) =>
      (stores.get(where.tenantId) ?? [])
        .filter(
          (store) => store.status === where.status && store.deletedAt === null
        )
        .slice(0, take)
        .map((store) => ({
          id: store.id,
          lastHealthyAt:
            store.lastHealthyAt === undefined
              ? new Date('2026-08-29T08:00:00.000Z')
              : store.lastHealthyAt,
          webhookSecretEncrypted:
            store.webhookSecretEncrypted === undefined
              ? 'encrypted-webhook-secret'
              : store.webhookSecretEncrypted,
          webhookEndpointKey:
            store.webhookEndpointKey === undefined
              ? 'whk_endpoint'
              : store.webhookEndpointKey,
        }))
  );
  const transactionClient = {
    telegramLinkToken: {
      findUnique: tokenFindUnique,
      updateMany: tokenUpdateMany,
    },
    telegramAccount: {
      findFirst: accountFindFirst,
      findUnique: accountFindUnique,
      create: accountCreate,
      update: accountUpdate,
    },
    telegramChatAuthorization: {
      findUnique: chatFindUnique,
      create: chatCreate,
      update: chatUpdate,
      updateMany: chatUpdateMany,
    },
    membership: { findMany: membershipFindMany },
    store: { findMany: storeFindMany },
  };
  const prisma = {
    telegramLinkToken: { create: tokenCreate },
    telegramAccount: { findUnique: accountFindUnique },
    membership: { findMany: membershipFindMany },
    store: { findMany: storeFindMany },
    $transaction: jest.fn(
      async (
        callback: (client: typeof transactionClient) => Promise<unknown>
      ) => callback(transactionClient)
    ),
  } as unknown as PrismaService;
  const configuration = {
    telegram: { linkTokenTtlSeconds: 900 },
  } as ApplicationConfigService;
  const resolveTenant = jest.fn(async () => ({
    plan: 'FREE',
    status: 'ACTIVE',
    effectiveState: 'ACTIVE',
    expiresAt: null,
  }));
  const entitlements = {
    resolveTenant,
  } as unknown as EntitlementService;
  const service = new TelegramLinkingService(
    prisma,
    configuration,
    entitlements
  );

  function addToken(
    raw: string,
    userId: string,
    expiresAt = new Date(Date.now() + 60_000)
  ): void {
    tokens.push({
      id: `token_${tokens.length}`,
      userId,
      tokenHash: hash(raw),
      expiresAt,
      consumedAt: null,
    });
  }

  function redeemInput(
    token: string,
    overrides: Partial<{
      telegramUserId: string;
      telegramChatId: string;
      updateId: string;
    }> = {}
  ) {
    return {
      telegramUserId: overrides.telegramUserId ?? '1001',
      telegramChatId: overrides.telegramChatId ?? '1001',
      chatType: 'private' as const,
      token,
      updateId: overrides.updateId ?? '5001',
    };
  }

  return {
    accounts,
    addToken,
    chats,
    memberships,
    redeemInput,
    resolveTenant,
    service,
    storeFindMany,
    stores,
    tokens,
  };
}

describe('TelegramLinkingService', () => {
  it('blocks inactive link-token issuance before persisting a token', async () => {
    const fixture = setup();
    fixture.memberships.set('usr_m16', ['ten_m16']);
    fixture.stores.set('ten_m16', [
      { id: 'sto_m16', status: StoreStatus.ACTIVE, deletedAt: null },
    ]);
    fixture.resolveTenant.mockResolvedValue({
      plan: 'FREE',
      status: 'SUSPENDED',
      effectiveState: 'SUSPENDED',
      expiresAt: null,
    });

    await expect(
      fixture.service.issueToken({ sub: 'usr_m16' })
    ).rejects.toMatchObject({
      response: { code: 'ENTITLEMENT_INACTIVE', effectiveState: 'SUSPENDED' },
    });
    expect(fixture.tokens).toHaveLength(0);
  });

  it('rejects redemption after suspension without consuming the issued token', async () => {
    const fixture = setup();
    fixture.memberships.set('usr_m16', ['ten_m16']);
    fixture.stores.set('ten_m16', [
      { id: 'sto_m16', status: StoreStatus.ACTIVE, deletedAt: null },
    ]);
    const issued = await fixture.service.issueToken({ sub: 'usr_m16' });
    fixture.resolveTenant.mockResolvedValue({
      plan: 'FREE',
      status: 'SUSPENDED',
      effectiveState: 'SUSPENDED',
      expiresAt: null,
    });

    await expect(
      fixture.service.redeem(fixture.redeemInput(issued.token))
    ).resolves.toMatchObject({
      status: 'entitlement_inactive',
      entitlement: { effectiveState: 'SUSPENDED' },
    });
    expect(fixture.tokens[0]?.consumedAt).toBeNull();
  });

  it('completes the M16 onboarding issuance-to-Telegram redemption path', async () => {
    const fixture = setup();
    fixture.memberships.set('usr_m16', ['ten_m16']);
    fixture.stores.set('ten_m16', [
      { id: 'sto_m16', status: StoreStatus.ACTIVE, deletedAt: null },
    ]);
    const controller = new TelegramInternalController(
      fixture.service,
      {} as TelegramOrderService,
      {} as never,
      {} as never,
      {} as never
    );

    const issued = await controller.issueToken({
      sub: 'usr_m16',
      tenantId: 'ten_m16',
    });
    const input = fixture.redeemInput(issued.token);

    expect(issued.token).toMatch(/^tgl_[A-Za-z0-9_-]{43}$/);
    expect(fixture.tokens[0]?.consumedAt).toBeNull();
    await expect(
      controller.redeem(input, input.updateId)
    ).resolves.toMatchObject({
      status: 'linked',
      activeTenantId: 'ten_m16',
      activeStoreId: 'sto_m16',
      selectionRequired: false,
    });
    expect(fixture.tokens[0]).toMatchObject({
      userId: 'usr_m16',
      tokenHash: hash(issued.token),
    });
    expect(fixture.tokens[0]?.consumedAt).toBeInstanceOf(Date);
    expect(fixture.accounts[0]).toMatchObject({ userId: 'usr_m16' });
  });

  it('issues a random token once and persists only its SHA-256 hash', async () => {
    const fixture = setup();
    fixture.memberships.set('usr_a', ['ten_a']);
    fixture.stores.set('ten_a', [
      { id: 'sto_a', status: StoreStatus.ACTIVE, deletedAt: null },
    ]);
    const issuedAtEarliest = Date.now();
    const result = await fixture.service.issueToken({ sub: 'usr_a' });
    const issuedAtLatest = Date.now();

    expect(result.token).toMatch(/^tgl_[A-Za-z0-9_-]{43}$/);
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(
      issuedAtEarliest + 900_000
    );
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(
      issuedAtLatest + 900_000
    );
    expect(fixture.tokens[0]?.tokenHash).toBe(hash(result.token));
    expect(JSON.stringify(fixture.tokens)).not.toContain(result.token);
    expect(fixture.storeFindMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'ten_a',
        status: StoreStatus.ACTIVE,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: {
        id: true,
        lastHealthyAt: true,
        webhookSecretEncrypted: true,
        webhookEndpointKey: true,
      },
      take: 2,
    });
  });

  it('denies direct link-token issuance before exact-one usable Store eligibility', async () => {
    const fixture = setup();
    fixture.memberships.set('usr_a', ['ten_a']);

    await expect(
      fixture.service.issueToken({ sub: 'usr_a' })
    ).rejects.toMatchObject({ status: 403 });
    expect(fixture.tokens).toHaveLength(0);

    fixture.stores.set('ten_a', [
      { id: 'sto_pending', status: StoreStatus.PENDING, deletedAt: null },
    ]);
    await expect(
      fixture.service.issueToken({ sub: 'usr_a' })
    ).rejects.toMatchObject({ status: 403 });
    expect(fixture.tokens).toHaveLength(0);

    fixture.stores.set('ten_a', [
      {
        id: 'sto_active_unhealthy',
        status: StoreStatus.ACTIVE,
        deletedAt: null,
        lastHealthyAt: null,
      },
    ]);
    await expect(
      fixture.service.issueToken({ sub: 'usr_a' })
    ).rejects.toMatchObject({ status: 403 });
    expect(fixture.tokens).toHaveLength(0);
  });

  it('denies link-token issuance when tenant selection would be required', async () => {
    const fixture = setup();
    fixture.memberships.set('usr_a', ['ten_a', 'ten_b']);

    await expect(
      fixture.service.issueToken({ sub: 'usr_a' })
    ).rejects.toMatchObject({ status: 403 });
    expect(fixture.tokens).toHaveLength(0);
  });

  it('redeems once, recovers an identical update, and hides other replay state', async () => {
    const fixture = setup();
    const raw = `tgl_${'a'.repeat(43)}`;
    fixture.addToken(raw, 'usr_a');
    fixture.memberships.set('usr_a', ['ten_a']);
    fixture.stores.set('ten_a', [
      { id: 'sto_a', status: StoreStatus.ACTIVE, deletedAt: null },
    ]);

    await expect(
      fixture.service.redeem(fixture.redeemInput(raw))
    ).resolves.toMatchObject({
      status: 'linked',
      activeTenantId: 'ten_a',
      activeStoreId: 'sto_a',
      selectionRequired: false,
    });
    fixture.tokens[0]!.expiresAt = new Date(Date.now() - 1);
    await expect(
      fixture.service.redeem(fixture.redeemInput(raw))
    ).resolves.toMatchObject({ status: 'linked' });
    await expect(
      fixture.service.redeem(fixture.redeemInput(raw, { updateId: '5002' }))
    ).resolves.toEqual({ status: 'invalid_or_expired' });
    await expect(
      fixture.service.redeem(fixture.redeemInput(`tgl_${'z'.repeat(43)}`))
    ).resolves.toEqual({ status: 'invalid_or_expired' });
  });

  it('returns the same generic result for expired and unknown tokens', async () => {
    const fixture = setup();
    const expired = `tgl_${'e'.repeat(43)}`;
    fixture.addToken(expired, 'usr_a', new Date(Date.now() - 1));

    await expect(
      fixture.service.redeem(fixture.redeemInput(expired))
    ).resolves.toEqual({ status: 'invalid_or_expired' });
    await expect(
      fixture.service.redeem(fixture.redeemInput(`tgl_${'u'.repeat(43)}`))
    ).resolves.toEqual({ status: 'invalid_or_expired' });
  });

  it('rejects duplicate Telegram user, SaaS user, and private-chat identities', async () => {
    const fixture = setup();
    for (const suffix of ['a', 'b', 'c']) {
      fixture.memberships.set(`usr_${suffix}`, [`ten_${suffix}`]);
      fixture.stores.set(`ten_${suffix}`, [
        {
          id: `sto_${suffix}`,
          status: StoreStatus.ACTIVE,
          deletedAt: null,
        },
      ]);
    }
    const first = `tgl_${'a'.repeat(43)}`;
    const second = `tgl_${'b'.repeat(43)}`;
    fixture.addToken(first, 'usr_a');
    fixture.addToken(second, 'usr_b');
    await fixture.service.redeem(fixture.redeemInput(first));

    await expect(
      fixture.service.redeem(fixture.redeemInput(second, { updateId: '5002' }))
    ).resolves.toEqual({ status: 'invalid_or_expired' });

    const third = `tgl_${'c'.repeat(43)}`;
    fixture.addToken(third, 'usr_a');
    await expect(
      fixture.service.redeem(
        fixture.redeemInput(third, {
          telegramUserId: '2002',
          telegramChatId: '2002',
          updateId: '5003',
        })
      )
    ).resolves.toEqual({ status: 'invalid_or_expired' });

    const fourth = `tgl_${'d'.repeat(43)}`;
    fixture.addToken(fourth, 'usr_c');
    await expect(
      fixture.service.redeem(
        fixture.redeemInput(fourth, {
          telegramUserId: '3003',
          telegramChatId: '1001',
          updateId: '5004',
        })
      )
    ).resolves.toEqual({ status: 'invalid_or_expired' });
  });

  it('rejects redemption if the issued User no longer has one eligible tenant and Store', async () => {
    const cases = [
      { tenants: [] as string[], stores: [] },
      {
        tenants: ['ten_a', 'ten_b'],
        stores: [],
      },
      {
        tenants: ['ten_a'],
        stores: [
          { id: 'sto_disabled', status: StoreStatus.DISABLED, deletedAt: null },
          {
            id: 'sto_deleted',
            status: StoreStatus.ACTIVE,
            deletedAt: new Date(),
          },
        ],
      },
      {
        tenants: ['ten_a'],
        stores: [
          {
            id: 'sto_unhealthy',
            status: StoreStatus.ACTIVE,
            deletedAt: null,
            lastHealthyAt: null,
          },
        ],
      },
    ];

    for (const [index, item] of cases.entries()) {
      const fixture = setup();
      const raw = `tgl_${String(index).repeat(43)}`;
      fixture.addToken(raw, 'usr_a');
      fixture.memberships.set('usr_a', item.tenants);
      fixture.stores.set('ten_a', item.stores);

      await expect(
        fixture.service.redeem(fixture.redeemInput(raw))
      ).resolves.toEqual({ status: 'invalid_or_expired' });
      expect(fixture.tokens[0]?.consumedAt).toBeNull();
    }
  });

  it('does not consume a token when tenant association changes before redemption', async () => {
    const fixture = setup();
    fixture.memberships.set('usr_a', ['ten_a']);
    fixture.stores.set('ten_a', [
      { id: 'sto_a', status: StoreStatus.ACTIVE, deletedAt: null },
    ]);
    const issued = await fixture.service.issueToken({ sub: 'usr_a' });

    fixture.memberships.set('usr_a', ['ten_wrong']);
    await expect(
      fixture.service.redeem(fixture.redeemInput(issued.token))
    ).resolves.toEqual({ status: 'invalid_or_expired' });
    expect(fixture.tokens[0]?.consumedAt).toBeNull();

    fixture.memberships.set('usr_a', ['ten_a']);
    await expect(
      fixture.service.redeem(fixture.redeemInput(issued.token))
    ).resolves.toMatchObject({
      status: 'linked',
      activeTenantId: 'ten_a',
      activeStoreId: 'sto_a',
    });
  });

  it('requires confirmation, revokes atomically, and makes repeats idempotent', async () => {
    const fixture = setup();
    fixture.memberships.set('usr_a', ['ten_a']);
    fixture.stores.set('ten_a', [
      { id: 'sto_a', status: StoreStatus.ACTIVE, deletedAt: null },
    ]);
    const raw = `tgl_${'x'.repeat(43)}`;
    fixture.addToken(raw, 'usr_a');
    await fixture.service.redeem(fixture.redeemInput(raw));
    const input = {
      telegramUserId: '1001',
      telegramChatId: '1001',
      updateId: '6001',
    };

    await expect(
      fixture.service.unlink({ ...input, confirmed: false })
    ).resolves.toEqual({ status: 'confirmation_required' });
    expect(fixture.accounts[0]?.deletedAt).toBeNull();

    await expect(
      fixture.service.unlink({ ...input, confirmed: true })
    ).resolves.toEqual({ status: 'unlinked' });
    await expect(
      fixture.service.unlink({ ...input, confirmed: true })
    ).resolves.toEqual({ status: 'unlinked' });
    await expect(fixture.service.status(input)).resolves.toMatchObject({
      linked: false,
      authorized: false,
    });
  });

  it('reuses a soft-revoked account for a later valid link by the same Telegram identity', async () => {
    const fixture = setup();
    fixture.memberships.set('usr_a', ['ten_a']);
    fixture.stores.set('ten_a', [
      { id: 'sto_a', status: StoreStatus.ACTIVE, deletedAt: null },
    ]);
    const first = await fixture.service.issueToken({ sub: 'usr_a' });
    await fixture.service.redeem(fixture.redeemInput(first.token));
    await fixture.service.unlink({
      telegramUserId: '1001',
      telegramChatId: '1001',
      updateId: '6001',
      confirmed: true,
    });

    const second = await fixture.service.issueToken({ sub: 'usr_a' });
    await expect(
      fixture.service.redeem(
        fixture.redeemInput(second.token, {
          telegramUserId: '1001',
          telegramChatId: '1001',
          updateId: '6002',
        })
      )
    ).resolves.toMatchObject({ status: 'linked' });

    expect(fixture.accounts).toHaveLength(1);
    expect(fixture.accounts[0]).toMatchObject({
      telegramUserId: BigInt(1001),
      deletedAt: null,
    });
    expect(
      fixture.chats.find((chat) => chat.telegramChatId === BigInt(1001))
        ?.revokedAt
    ).toBeNull();
  });

  it('allows an explicitly unlinked pilot Telegram identity to link the new M16 User', async () => {
    const fixture = setup();
    fixture.memberships.set('usr_pilot', ['ten_pilot']);
    fixture.stores.set('ten_pilot', [
      { id: 'sto_pilot', status: StoreStatus.ACTIVE, deletedAt: null },
    ]);
    const pilotToken = await fixture.service.issueToken({ sub: 'usr_pilot' });
    await fixture.service.redeem(fixture.redeemInput(pilotToken.token));
    await fixture.service.unlink({
      telegramUserId: '1001',
      telegramChatId: '1001',
      updateId: '6001',
      confirmed: true,
    });

    fixture.memberships.set('usr_m16', ['ten_m16']);
    fixture.stores.set('ten_m16', [
      { id: 'sto_m16', status: StoreStatus.ACTIVE, deletedAt: null },
    ]);
    const controller = new TelegramInternalController(
      fixture.service,
      {} as TelegramOrderService,
      {} as never,
      {} as never,
      {} as never
    );
    const m16Token = await controller.issueToken({
      sub: 'usr_m16',
      tenantId: 'ten_m16',
    });
    const input = fixture.redeemInput(m16Token.token, { updateId: '6002' });

    await expect(
      controller.redeem(input, input.updateId)
    ).resolves.toMatchObject({
      status: 'linked',
      activeTenantId: 'ten_m16',
      activeStoreId: 'sto_m16',
    });
    expect(fixture.accounts).toHaveLength(1);
    expect(fixture.accounts[0]).toMatchObject({
      userId: 'usr_m16',
      telegramUserId: BigInt(1001),
      deletedAt: null,
    });
    expect(fixture.chats[0]).toMatchObject({
      revokedAt: null,
      activeTenantId: 'ten_m16',
      activeStoreId: 'sto_m16',
    });

    await expect(
      controller.redeem(
        fixture.redeemInput(m16Token.token, { updateId: '6003' }),
        '6003'
      )
    ).resolves.toEqual({ status: 'invalid_or_expired' });
  });
});
