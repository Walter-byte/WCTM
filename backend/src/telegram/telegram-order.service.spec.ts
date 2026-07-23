import { describe, expect, it, jest } from '@jest/globals';
import { MembershipRole, TelegramCallbackPurpose } from '@prisma/client';

import type { ApplicationConfigService } from '../config/application-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import { TelegramOrderService } from './telegram-order.service';

interface TestOrder {
  tenantId: string;
  storeId: string;
  wcOrderId: string;
  orderNumber: string;
  status: string;
  currency: string;
  totals: Record<string, string>;
  customerSnapshot: {
    billing: { first_name: string; last_name: string };
  };
  lineItemsSnapshot: Array<{
    name: string;
    quantity: number;
    total: string;
  }>;
  wcCreatedAt: Date;
  wcModifiedAt: Date;
  remoteDeletedAt: Date | null;
  lastSyncedAt: Date;
}

interface TestReference {
  id: string;
  telegramAccountId: string;
  telegramChatId: bigint;
  tenantId: string;
  storeId: string;
  purpose: string;
  direction?: string | null;
  boundaryWcCreatedAt?: Date | null;
  boundaryWcOrderId?: string | null;
  targetWcOrderId?: string | null;
  reachableOffset?: number | null;
  backReferenceId?: string | null;
  expiresAt: Date;
}

function makeOrder(
  index: number,
  overrides: Partial<TestOrder> = {}
): TestOrder {
  const created = new Date(Date.UTC(2026, 6, 23, 12, 0, Math.floor(index / 2)));

  return {
    tenantId: 'ten_a',
    storeId: 'sto_a',
    wcOrderId: String(1000 + index),
    orderNumber: String(1000 + index),
    status: 'processing',
    currency: 'IRR',
    totals: { total: `${index}.00`, total_tax: '0.00' },
    customerSnapshot: {
      billing: { first_name: `Customer${index}`, last_name: 'Test' },
    },
    lineItemsSnapshot: [
      { name: `Item ${index}`, quantity: 1, total: `${index}.00` },
    ],
    wcCreatedAt: created,
    wcModifiedAt: created,
    remoteDeletedAt: null,
    lastSyncedAt: new Date('2026-07-23T12:10:00.000Z'),
    ...overrides,
  };
}

function createFixture(orderCount = 18) {
  const references: TestReference[] = [];
  const orders = Array.from({ length: orderCount }, (_, index) =>
    makeOrder(index + 1)
  );
  const state: {
    accountDeleted: boolean;
    chatRevoked: boolean;
    membershipRole: MembershipRole;
    membershipDeleted: boolean;
    membershipCount: number;
    storeCount: number;
    activeStoreId: string;
  } = {
    accountDeleted: false,
    chatRevoked: false,
    membershipRole: MembershipRole.MEMBER,
    membershipDeleted: false,
    membershipCount: 1,
    storeCount: 1,
    activeStoreId: 'sto_a',
  };

  const prisma = {
    telegramAccount: {
      findUnique: jest.fn(
        async ({ where }: { where: { telegramUserId: bigint } }) =>
          where.telegramUserId === BigInt(1001)
            ? {
                id: 'tga_a',
                userId: 'usr_a',
                deletedAt: state.accountDeleted ? new Date() : null,
                chatAuthorizations: !state.chatRevoked
                  ? [
                      {
                        telegramAccountId: 'tga_a',
                        telegramChatId: BigInt(1001),
                      },
                    ]
                  : [],
              }
            : null
      ),
    },
    membership: {
      findMany: jest.fn(async () =>
        state.membershipDeleted
          ? []
          : Array.from({ length: state.membershipCount }, (_, index) => ({
              tenantId: index === 0 ? 'ten_a' : `ten_${index + 1}`,
              role: state.membershipRole,
            }))
      ),
    },
    store: {
      findMany: jest.fn(async () =>
        Array.from({ length: state.storeCount }, (_, index) => ({
          id: index === 0 ? state.activeStoreId : `sto_${index + 1}`,
        }))
      ),
    },
    order: {
      findMany: jest.fn(
        async ({
          where,
          orderBy,
          take,
        }: {
          where: {
            tenantId: string;
            storeId: string;
            OR?: Array<Record<string, unknown>>;
          };
          orderBy: Array<Record<string, 'asc' | 'desc'>>;
          take: number;
        }) => {
          let result = orders.filter(
            (order) =>
              order.tenantId === where.tenantId &&
              order.storeId === where.storeId
          );
          const timestampRule = where.OR?.[0]?.['wcCreatedAt'] as
            { gt?: Date; lt?: Date } | undefined;
          const tiedRule = where.OR?.[1] as
            | {
                wcCreatedAt?: Date;
                wcOrderId?: { gt?: string; lt?: string };
              }
            | undefined;

          if (timestampRule && tiedRule?.wcCreatedAt && tiedRule.wcOrderId) {
            result = result.filter((order) => {
              if (timestampRule.gt && order.wcCreatedAt > timestampRule.gt) {
                return true;
              }
              if (timestampRule.lt && order.wcCreatedAt < timestampRule.lt) {
                return true;
              }

              if (
                order.wcCreatedAt.getTime() !== tiedRule.wcCreatedAt!.getTime()
              ) {
                return false;
              }

              return tiedRule.wcOrderId!.gt
                ? order.wcOrderId > tiedRule.wcOrderId!.gt
                : order.wcOrderId < tiedRule.wcOrderId!.lt!;
            });
          }

          const ascending = orderBy[0]?.['wcCreatedAt'] === 'asc';
          result.sort((left, right) => {
            const dateComparison =
              left.wcCreatedAt.getTime() - right.wcCreatedAt.getTime();
            const idComparison = left.wcOrderId.localeCompare(right.wcOrderId);
            const comparison = dateComparison || idComparison;

            return ascending ? comparison : -comparison;
          });

          return result.slice(0, take);
        }
      ),
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { tenantId: string; storeId: string; wcOrderId: string };
        }) =>
          orders.find(
            (order) =>
              order.tenantId === where.tenantId &&
              order.storeId === where.storeId &&
              order.wcOrderId === where.wcOrderId
          ) ?? null
      ),
    },
    telegramCallbackReference: {
      createMany: jest.fn(async ({ data }: { data: TestReference[] }) => {
        references.push(...data);
        return { count: data.length };
      }),
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          references.find((reference) => reference.id === where.id) ?? null
      ),
    },
  };
  const configuration = {
    telegram: {
      callbackSigningKey: 'test-callback-signing-key-at-least-32-chars',
      callbackRefTtlSeconds: 900,
      orderFreshnessThresholdSeconds: 300,
    },
  } as ApplicationConfigService;
  const service = new TelegramOrderService(
    prisma as unknown as PrismaService,
    configuration
  );
  const identity = { userId: '1001', chatId: '1001' };

  return {
    service,
    prisma,
    configuration,
    state,
    orders,
    references,
    identity,
  };
}

describe('TelegramOrderService authorization and isolation', () => {
  it.each([MembershipRole.OWNER, MembershipRole.ADMIN, MembershipRole.MEMBER])(
    'allows active %s memberships to read projected orders',
    async (role) => {
      const fixture = createFixture(1);
      fixture.state.membershipRole = role;

      const result = await fixture.service.list({
        telegram: fixture.identity,
      });

      expect(result.state).toBe('OK');
      expect(result.orders).toHaveLength(1);
    }
  );

  it('rejects unlinked, revoked, and soft-deleted membership contexts', async () => {
    const fixture = createFixture(1);
    fixture.state.accountDeleted = true;
    expect(
      await fixture.service.list({ telegram: fixture.identity })
    ).toMatchObject({ state: 'UNAUTHORIZED', orders: [] });

    fixture.state.accountDeleted = false;
    fixture.state.chatRevoked = true;
    expect(
      await fixture.service.list({ telegram: fixture.identity })
    ).toMatchObject({ state: 'UNAUTHORIZED', orders: [] });

    fixture.state.chatRevoked = false;
    fixture.state.membershipDeleted = true;
    expect(
      await fixture.service.list({ telegram: fixture.identity })
    ).toMatchObject({ state: 'UNAUTHORIZED', orders: [] });
  });

  it('requires exactly one membership and one active Store', async () => {
    const fixture = createFixture(1);
    fixture.state.membershipCount = 2;
    expect(
      await fixture.service.list({ telegram: fixture.identity })
    ).toMatchObject({ state: 'NO_ACTIVE_STORE' });

    fixture.state.membershipCount = 1;
    fixture.state.storeCount = 0;
    expect(
      await fixture.service.list({ telegram: fixture.identity })
    ).toMatchObject({ state: 'NO_ACTIVE_STORE' });

    fixture.state.storeCount = 2;
    expect(
      await fixture.service.list({ telegram: fixture.identity })
    ).toMatchObject({ state: 'NO_ACTIVE_STORE' });
  });

  it('keeps every order query tenant- and Store-scoped', async () => {
    const fixture = createFixture(1);
    fixture.orders.push(
      makeOrder(99, {
        tenantId: 'ten_b',
        storeId: 'sto_b',
        orderNumber: 'cross-tenant',
      })
    );

    const result = await fixture.service.list({
      telegram: fixture.identity,
    });

    expect(result.orders.map((order) => order.orderNumber)).not.toContain(
      'cross-tenant'
    );
    expect(fixture.prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'ten_a',
          storeId: 'sto_a',
        }),
      })
    );
  });
});

describe('TelegramOrderService keyset pagination and references', () => {
  it('uses the full timestamp/id boundary without skips or duplicates', async () => {
    const fixture = createFixture(18);
    const first = await fixture.service.list({ telegram: fixture.identity });
    const second = await fixture.service.list({
      telegram: fixture.identity,
      cursor: first.nextCursor!,
    });
    const third = await fixture.service.list({
      telegram: fixture.identity,
      cursor: second.nextCursor!,
    });
    const seen = [...first.orders, ...second.orders, ...third.orders].map(
      (order) => order.orderNumber
    );

    expect(first.orders).toHaveLength(8);
    expect(second.orders).toHaveLength(8);
    expect(third.orders).toHaveLength(2);
    expect(new Set(seen).size).toBe(18);
    expect(third.nextCursor).toBeNull();

    const back = await fixture.service.list({
      telegram: fixture.identity,
      cursor: third.previousCursor!,
    });
    expect(back.orders.map((order) => order.orderNumber)).toEqual(
      second.orders.map((order) => order.orderNumber)
    );
  });

  it('caps the reachable keyset window at 200 rows', async () => {
    const fixture = createFixture(205);
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 25; page += 1) {
      const result = await fixture.service.list({
        telegram: fixture.identity,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.orders.map((order) => order.orderNumber));
      cursor = result.nextCursor ?? undefined;
    }

    expect(seen).toHaveLength(200);
    expect(new Set(seen).size).toBe(200);
    expect(cursor).toBeUndefined();
  });

  it('rejects tampered, expired, and context-mismatched cursor references', async () => {
    const fixture = createFixture(10);
    const first = await fixture.service.list({ telegram: fixture.identity });
    const cursor = first.nextCursor!;
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;

    expect(
      await fixture.service.list({
        telegram: fixture.identity,
        cursor: tampered,
      })
    ).toMatchObject({ state: 'CONTEXT_CHANGED' });

    const reference = fixture.references.find(
      (candidate) =>
        candidate.purpose === TelegramCallbackPurpose.LIST_PAGE &&
        candidate.id === `tcr_${cursor.split('.')[1]}`
    )!;
    reference.expiresAt = new Date(0);
    expect(
      await fixture.service.list({ telegram: fixture.identity, cursor })
    ).toMatchObject({ state: 'CONTEXT_CHANGED' });

    const fresh = await fixture.service.list({ telegram: fixture.identity });
    fixture.state.activeStoreId = 'sto_changed';
    expect(
      await fixture.service.list({
        telegram: fixture.identity,
        cursor: fresh.nextCursor!,
      })
    ).toMatchObject({ state: 'CONTEXT_CHANGED' });
  });

  it('keeps every callback token within Telegram limits', async () => {
    const fixture = createFixture(10);
    const result = await fixture.service.list({ telegram: fixture.identity });
    const tokens = [
      ...result.orders.map((order) => order.ref),
      result.nextCursor!,
    ];

    expect(tokens.every((token) => token.length <= 64)).toBe(true);
    expect(tokens.every((token) => !token.includes('ten_a'))).toBe(true);
    expect(tokens.every((token) => !token.includes('sto_a'))).toBe(true);
  });
});

describe('TelegramOrderService detail and freshness', () => {
  it('returns sanitized projected detail and lastSyncedAt freshness', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-23T12:12:00.000Z'));
    const fixture = createFixture(1);
    const list = await fixture.service.list({ telegram: fixture.identity });
    const detail = await fixture.service.detail({
      telegram: fixture.identity,
      ref: list.orders[0]!.ref,
    });

    expect(detail).toMatchObject({
      state: 'OK',
      freshness: {
        asOf: '2026-07-23T12:10:00.000Z',
        delayed: false,
      },
      order: {
        customerDisplayName: 'Customer1 Test',
        lineItems: [{ name: 'Item 1', quantity: 1, total: '1.00' }],
        remoteDeleted: false,
      },
    });
    expect(detail.backCursor).toMatch(/^p\./);
    jest.useRealTimers();
  });

  it('returns a minimal DELETED marker without totals or line items', async () => {
    const fixture = createFixture(1);
    fixture.orders[0]!.remoteDeletedAt = new Date();
    const list = await fixture.service.list({ telegram: fixture.identity });
    const detail = await fixture.service.detail({
      telegram: fixture.identity,
      ref: list.orders[0]!.ref,
    });

    expect(detail.state).toBe('DELETED');
    expect(detail.order).toEqual({
      orderNumber: '1001',
      status: 'processing',
      customerDisplayName: 'Customer1 Test',
      remoteDeleted: true,
    });
    expect(detail.order).not.toHaveProperty('lineItems');
    expect(detail.order).not.toHaveProperty('totals');
  });

  it('marks stale projections delayed and missing targets NOT_FOUND', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-23T13:00:00.000Z'));
    const fixture = createFixture(1);
    const list = await fixture.service.list({ telegram: fixture.identity });
    expect(list.freshness.delayed).toBe(true);

    fixture.orders.length = 0;
    const detail = await fixture.service.detail({
      telegram: fixture.identity,
      ref: list.orders[0]!.ref,
    });
    expect(detail.state).toBe('NOT_FOUND');
    jest.useRealTimers();
  });
});
