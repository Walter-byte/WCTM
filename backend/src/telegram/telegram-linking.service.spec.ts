import { describe, expect, it, jest } from '@jest/globals';
import { StoreStatus } from '@prisma/client';
import { createHash } from 'node:crypto';

import type { ApplicationConfigService } from '../config/application-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import { TelegramLinkingService } from './telegram-linking.service';

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
  const service = new TelegramLinkingService(prisma, configuration);

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
    service,
    storeFindMany,
    stores,
    tokens,
  };
}

describe('TelegramLinkingService', () => {
  it('issues a random token once and persists only its SHA-256 hash', async () => {
    const fixture = setup();
    fixture.memberships.set('usr_a', ['ten_a']);
    fixture.stores.set('ten_a', [
      { id: 'sto_a', status: StoreStatus.ACTIVE, deletedAt: null },
    ]);
    const result = await fixture.service.issueToken({ sub: 'usr_a' });

    expect(result.token).toMatch(/^tgl_[A-Za-z0-9_-]{43}$/);
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

  it('resolves only exactly one active tenant and one active Store', async () => {
    const cases = [
      { tenants: [] as string[], stores: [], selectionRequired: true },
      {
        tenants: ['ten_a', 'ten_b'],
        stores: [],
        selectionRequired: true,
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
        selectionRequired: true,
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
      ).resolves.toMatchObject({
        status: 'linked',
        activeTenantId: null,
        activeStoreId: null,
        selectionRequired: item.selectionRequired,
      });
    }
  });

  it('requires confirmation, revokes atomically, and makes repeats idempotent', async () => {
    const fixture = setup();
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
    const first = `tgl_${'r'.repeat(43)}`;
    fixture.addToken(first, 'usr_a');
    await fixture.service.redeem(fixture.redeemInput(first));
    await fixture.service.unlink({
      telegramUserId: '1001',
      telegramChatId: '1001',
      updateId: '6001',
      confirmed: true,
    });

    const second = `tgl_${'s'.repeat(43)}`;
    fixture.addToken(second, 'usr_a');
    await expect(
      fixture.service.redeem(
        fixture.redeemInput(second, {
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
});
