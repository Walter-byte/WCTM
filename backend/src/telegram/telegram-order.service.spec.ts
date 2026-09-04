import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  MembershipRole,
  NotificationCategory,
  NotificationRecipientMode,
  TelegramCallbackPurpose,
  TelegramOrderNoteActionState,
  TelegramOrderNoteVisibility,
} from '@prisma/client';

import type { ApplicationConfigService } from '../config/application-config.service';
import {
  EntitlementInactiveException,
  type EntitlementService,
} from '../entitlements/entitlement.service';
import type { EncryptionService } from '../common/encryption/encryption.service';
import type { OrderProjectionService } from '../orders/order-projection.service';
import {
  WooCommerceClient,
  WooCommerceClientError,
} from '../woocommerce/client/woocommerce.client';
import type { PrismaService } from '../prisma/prisma.service';
import { TelegramOrderService } from './telegram-order.service';

afterEach(() => {
  jest.restoreAllMocks();
});

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
    shipping?: Record<string, string>;
  };
  lineItemsSnapshot: Array<{
    name: string;
    quantity: number;
    total: string;
  }>;
  paymentSnapshot: {
    method: string | null;
    method_title: string | null;
    paid: boolean;
  };
  shippingLinesSnapshot: Array<{
    method_id: string | null;
    method_title: string | null;
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
  allowedTargetStatuses?: string[];
  claimedTargetStatus?: string | null;
  noteVisibility?: TelegramOrderNoteVisibility | null;
  noteBodyEncrypted?: string | null;
  noteContentFingerprint?: string | null;
  noteClaimedAt?: Date | null;
  expiresAt: Date;
}

interface TestStatusWrite {
  id: string;
  callbackReferenceId: string;
  targetStatus: string;
  result?: unknown;
}

interface TestNoteAction {
  id: string;
  callbackReferenceId: string;
  visibility: TelegramOrderNoteVisibility;
  state: TelegramOrderNoteActionState;
  result?: unknown;
  startedAt: Date;
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
      shipping: {
        address_1: 'Fulfillment Street 1',
        city: 'Tehran',
        postcode: '12345',
        country: 'IR',
        phone: 'must-not-leak',
        email: 'must-not-leak@example.test',
      },
    },
    lineItemsSnapshot: [
      { name: `Item ${index}`, quantity: 1, total: `${index}.00` },
    ],
    paymentSnapshot: {
      method: 'cod',
      method_title: 'Cash on delivery',
      paid: false,
    },
    shippingLinesSnapshot: [
      { method_id: 'flat_rate', method_title: 'Flat rate' },
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
  const statusWrites: TestStatusWrite[] = [];
  const noteActions: TestNoteAction[] = [];
  const auditLogs: unknown[] = [];
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
    enabledNotificationCategories: NotificationCategory[];
    notificationRecipientMode: NotificationRecipientMode;
    selectedMembershipIds: string[];
  } = {
    accountDeleted: false,
    chatRevoked: false,
    membershipRole: MembershipRole.MEMBER,
    membershipDeleted: false,
    membershipCount: 1,
    storeCount: 1,
    activeStoreId: 'sto_a',
    enabledNotificationCategories: [NotificationCategory.ORDER_CREATED],
    notificationRecipientMode: NotificationRecipientMode.ALL_ELIGIBLE,
    selectedMembershipIds: [],
  };

  const prisma = {
    telegramChatAuthorization: {
      findMany: jest.fn(async () =>
        state.chatRevoked
          ? []
          : [
              {
                id: 'tca_a',
                telegramAccountId: 'tga_a',
                telegramChatId: BigInt(1001),
                telegramAccount: { telegramUserId: BigInt(1001) },
              },
            ]
      ),
    },
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
              id: index === 0 ? 'mem_a' : `mem_${index + 1}`,
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
      findFirst: jest.fn(async () => ({
        id: 'sto_a',
        tenantId: 'ten_a',
        baseUrl: 'https://shop.example',
        consumerKeyEncrypted: 'encrypted-key',
        consumerSecretEncrypted: 'encrypted-secret',
        enabledNotificationCategories: state.enabledNotificationCategories,
        notificationRecipientMode: state.notificationRecipientMode,
        selectedNotificationRecipients: state.selectedMembershipIds.map(
          (membershipId) => ({ id: `snr_${membershipId}` })
        ),
      })),
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
            orderNumber?: string;
            OR?: Array<Record<string, unknown>>;
          };
          orderBy?: Array<Record<string, 'asc' | 'desc'>>;
          take: number;
        }) => {
          let result = orders.filter(
            (order) =>
              order.tenantId === where.tenantId &&
              order.storeId === where.storeId
          );

          if (where.orderNumber !== undefined) {
            result = result.filter(
              (order) => order.orderNumber === where.orderNumber
            );
          }
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

          const ascending = orderBy?.[0]?.['wcCreatedAt'] === 'asc';
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
      create: jest.fn(async ({ data }: { data: TestReference }) => {
        references.push(data);
        return { id: data.id };
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: {
            id?: string;
            purpose?: string;
            noteClaimedAt?: null;
            noteBodyEncrypted?: { not: null };
            expiresAt?: { gt?: Date; lte?: Date };
          };
          data: Partial<TestReference>;
        }) => {
          const reference = references.find((candidate) => {
            if (where.id && candidate.id !== where.id) {
              return false;
            }

            if (where.purpose && candidate.purpose !== where.purpose) {
              return false;
            }

            if (
              where.noteClaimedAt === null &&
              candidate.noteClaimedAt != null
            ) {
              return false;
            }

            if (
              where.noteBodyEncrypted?.not === null &&
              candidate.noteBodyEncrypted == null
            ) {
              return false;
            }

            if (
              where.expiresAt?.gt &&
              candidate.expiresAt <= where.expiresAt.gt
            ) {
              return false;
            }

            if (
              where.expiresAt?.lte &&
              candidate.expiresAt > where.expiresAt.lte
            ) {
              return false;
            }

            return true;
          });

          if (
            !reference ||
            (data.claimedTargetStatus &&
              reference.claimedTargetStatus &&
              reference.claimedTargetStatus !== data.claimedTargetStatus)
          ) {
            return { count: 0 };
          }

          Object.assign(reference, data);
          return { count: 1 };
        }
      ),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<TestReference>;
        }) => {
          const reference = references.find(
            (candidate) => candidate.id === where.id
          )!;
          Object.assign(reference, data);
          return { id: reference.id };
        }
      ),
    },
    telegramOrderStatusWrite: {
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: {
            callbackReferenceId_targetStatus: {
              callbackReferenceId: string;
              targetStatus: string;
            };
          };
        }) =>
          statusWrites.find(
            (write) =>
              write.callbackReferenceId ===
                where.callbackReferenceId_targetStatus.callbackReferenceId &&
              write.targetStatus ===
                where.callbackReferenceId_targetStatus.targetStatus
          ) ?? null
      ),
      create: jest.fn(async ({ data }: { data: TestStatusWrite }) => {
        statusWrites.push(data);
        return { id: data.id };
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { result: unknown };
        }) => {
          const write = statusWrites.find(
            (candidate) => candidate.id === where.id
          )!;
          write.result = data.result;
          return { id: write.id };
        }
      ),
    },
    telegramOrderNoteAction: {
      findUnique: jest.fn(
        async ({ where }: { where: { callbackReferenceId: string } }) => {
          const action = noteActions.find(
            (candidate) =>
              candidate.callbackReferenceId === where.callbackReferenceId
          );

          if (!action) {
            return null;
          }

          const reference = references.find(
            (candidate) => candidate.id === action.callbackReferenceId
          );
          return {
            ...action,
            callbackReference: {
              backReferenceId: reference?.backReferenceId ?? null,
            },
          };
        }
      ),
      create: jest.fn(async ({ data }: { data: TestNoteAction }) => {
        if (
          noteActions.some(
            (candidate) =>
              candidate.callbackReferenceId === data.callbackReferenceId
          )
        ) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }

        noteActions.push({
          ...data,
          state: TelegramOrderNoteActionState.IN_FLIGHT,
          startedAt: new Date(),
        });
        return { id: data.id };
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<TestNoteAction>;
        }) => {
          const action = noteActions.find(
            (candidate) => candidate.id === where.id
          )!;
          Object.assign(action, data);
          return { id: action.id };
        }
      ),
    },
    auditLog: {
      create: jest.fn(async ({ data }: { data: unknown }) => {
        auditLogs.push(data);
        return { id: 'aud_test' };
      }),
    },
    $transaction: jest.fn(
      async (
        operation:
          | Array<Promise<unknown>>
          | ((transaction: typeof prisma) => Promise<unknown>)
      ) =>
        typeof operation === 'function'
          ? operation(prisma)
          : Promise.all(operation)
    ),
  };
  const configuration = {
    telegram: {
      callbackSigningKey: 'test-callback-signing-key-at-least-32-chars',
      callbackRefTtlSeconds: 900,
      orderFreshnessThresholdSeconds: 300,
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
  const projection = {
    reconcileAuthoritativeOrder: jest.fn(
      async (
        _store: unknown,
        payload: { status: string },
        wcOrderId: string
      ) => {
        const order = orders.find(
          (candidate) => candidate.wcOrderId === wcOrderId
        );
        if (order) {
          order.status = payload.status;
          order.lastSyncedAt = new Date();
        }
      }
    ),
  };
  const assertActive = jest.fn(async () => undefined);
  const service = new TelegramOrderService(
    prisma as unknown as PrismaService,
    configuration,
    {
      encrypt: (value: string) => `encrypted:${value}`,
      decrypt: (value: string) => value.replace(/^encrypted:/, ''),
    } as EncryptionService,
    projection as unknown as OrderProjectionService,
    { assertActive } as unknown as EntitlementService
  );
  const identity = { userId: '1001', chatId: '1001' };

  return {
    service,
    prisma,
    configuration,
    state,
    orders,
    references,
    statusWrites,
    noteActions,
    auditLogs,
    projection,
    assertActive,
    identity,
  };
}

describe('M13 recipient and existing action reuse', () => {
  it('discovers only recipients whose current M11 context matches the Order', async () => {
    const fixture = createFixture(1);

    await expect(
      fixture.service.eligibleNotificationRecipients('ten_a', 'sto_a')
    ).resolves.toEqual([
      {
        membershipId: 'mem_a',
        telegramAccountId: 'tga_a',
        telegramChatAuthorizationId: 'tca_a',
        telegramUserId: '1001',
        telegramChatId: '1001',
      },
    ]);

    fixture.state.activeStoreId = 'sto_changed';
    await expect(
      fixture.service.eligibleNotificationRecipients('ten_a', 'sto_a')
    ).resolves.toEqual([]);

    fixture.state.activeStoreId = 'sto_a';
    fixture.state.membershipCount = 2;
    await expect(
      fixture.service.eligibleNotificationRecipients('ten_a', 'sto_a')
    ).resolves.toEqual([]);

    fixture.state.membershipCount = 1;
    fixture.state.chatRevoked = true;
    await expect(
      fixture.service.eligibleNotificationRecipients('ten_a', 'sto_a')
    ).resolves.toEqual([]);
  });

  it('creates a native M11 detail reference and enters the unchanged M12 flow', async () => {
    const fixture = createFixture(1);
    fixture.state.membershipRole = MembershipRole.OWNER;
    const recipient = {
      telegramAccountId: 'tga_a',
      telegramChatAuthorizationId: 'tca_a',
      telegramUserId: '1001',
      telegramChatId: '1001',
    };
    const prepared = await fixture.service.prepareOrderNotification(
      recipient,
      'ten_a',
      'sto_a',
      '1001'
    );

    expect(prepared).toMatchObject({
      state: 'OK',
      viewOrderRef: expect.stringMatching(/^d\./),
      changeStatusAvailable: true,
    });

    if (prepared.state !== 'OK') {
      throw new Error('Expected a prepared notification');
    }

    await expect(
      fixture.service.detail({
        telegram: fixture.identity,
        ref: prepared.viewOrderRef,
      })
    ).resolves.toMatchObject({
      state: 'OK',
      transitionsRef: prepared.viewOrderRef,
    });
    await expect(
      fixture.service.transitions({
        telegram: fixture.identity,
        ref: prepared.viewOrderRef,
      })
    ).resolves.toMatchObject({
      state: 'OK',
      ref: expect.stringMatching(/^s\./),
      targets: ['on-hold', 'completed', 'cancelled', 'refunded'],
    });
  });

  it('uses the same M12 capability boundary for MEMBER recipients', async () => {
    const fixture = createFixture(1);
    fixture.state.membershipRole = MembershipRole.MEMBER;

    await expect(
      fixture.service.prepareOrderNotification(
        {
          telegramAccountId: 'tga_a',
          telegramChatAuthorizationId: 'tca_a',
          telegramUserId: '1001',
          telegramChatId: '1001',
        },
        'ten_a',
        'sto_a',
        '1001'
      )
    ).resolves.toMatchObject({
      state: 'OK',
      changeStatusAvailable: false,
    });
  });

  it('revalidates category and selected Membership policy before dispatch', async () => {
    const fixture = createFixture(1);
    const recipient = {
      membershipId: 'mem_a',
      telegramAccountId: 'tga_a',
      telegramChatAuthorizationId: 'tca_a',
      telegramUserId: '1001',
      telegramChatId: '1001',
    };

    fixture.state.enabledNotificationCategories = [];
    await expect(
      fixture.service.prepareOrderNotification(
        recipient,
        'ten_a',
        'sto_a',
        '1001'
      )
    ).resolves.toEqual({ state: 'DISABLED' });

    fixture.state.enabledNotificationCategories = [
      NotificationCategory.ORDER_CREATED,
    ];
    fixture.state.notificationRecipientMode =
      NotificationRecipientMode.SELECTED;
    await expect(
      fixture.service.prepareOrderNotification(
        recipient,
        'ten_a',
        'sto_a',
        '1001'
      )
    ).resolves.toEqual({ state: 'DISABLED' });

    fixture.state.selectedMembershipIds = ['mem_a'];
    await expect(
      fixture.service.prepareOrderNotification(
        recipient,
        'ten_a',
        'sto_a',
        '1001'
      )
    ).resolves.toMatchObject({ state: 'OK' });
  });

  it('keeps Membership identity authoritative across unlink and relink', async () => {
    const fixture = createFixture(1);
    fixture.state.notificationRecipientMode =
      NotificationRecipientMode.SELECTED;
    fixture.state.selectedMembershipIds = ['mem_a'];

    fixture.state.chatRevoked = true;
    await expect(
      fixture.service.eligibleNotificationRecipients('ten_a', 'sto_a')
    ).resolves.toEqual([]);

    fixture.state.chatRevoked = false;
    await expect(
      fixture.service.eligibleNotificationRecipients('ten_a', 'sto_a')
    ).resolves.toEqual([expect.objectContaining({ membershipId: 'mem_a' })]);
  });
});

function wooPayload(status: string) {
  return {
    id: 1001,
    number: '1001',
    status,
    currency: 'IRR',
    discount_total: '0',
    discount_tax: '0',
    shipping_total: '0',
    shipping_tax: '0',
    cart_tax: '0',
    total: '1.00',
    total_tax: '0',
    customer_id: 1,
    billing: { first_name: 'Customer1', last_name: 'Test' },
    shipping: {},
    payment_method: 'cod',
    payment_method_title: 'Cash on delivery',
    date_paid_gmt: null,
    shipping_lines: [{ method_id: 'flat_rate', method_title: 'Flat rate' }],
    line_items: [{ name: 'Item 1', quantity: 1, total: '1.00' }],
    date_created_gmt: '2026-07-23T12:00:00Z',
    date_modified_gmt: '2026-07-23T12:20:00Z',
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

describe('TelegramOrderService status writes', () => {
  async function writeReference(
    fixture: ReturnType<typeof createFixture>
  ): Promise<string> {
    fixture.state.membershipRole = MembershipRole.OWNER;
    const list = await fixture.service.list({ telegram: fixture.identity });
    const transitions = await fixture.service.transitions({
      telegram: fixture.identity,
      ref: list.orders[0]!.ref,
    });

    expect(transitions).toMatchObject({
      state: 'OK',
      currentStatus: 'processing',
      targets: expect.arrayContaining(['completed']),
    });

    return transitions.ref!;
  }

  it('updates WooCommerce once, reconciles the projection, audits, and replays the prior result', async () => {
    const fixture = createFixture(1);
    const ref = await writeReference(fixture);
    jest
      .spyOn(WooCommerceClient.prototype, 'fetchOrder')
      .mockResolvedValue(wooPayload('processing'));
    const update = jest
      .spyOn(WooCommerceClient.prototype, 'updateOrderStatus')
      .mockResolvedValue(wooPayload('completed'));

    const first = await fixture.service.updateStatus({
      telegram: fixture.identity,
      ref,
      target: 'completed',
    });
    const replay = await fixture.service.updateStatus({
      telegram: fixture.identity,
      ref,
      target: 'completed',
    });

    expect(first).toMatchObject({
      state: 'OK',
      order: { status: 'completed' },
    });
    expect(replay).toEqual(first);
    expect(update).toHaveBeenCalledTimes(1);
    expect(fixture.orders[0]!.status).toBe('completed');
    expect(fixture.auditLogs).toHaveLength(1);
  });

  it('revalidates entitlement immediately before a claimed status write', async () => {
    const fixture = createFixture(1);
    const ref = await writeReference(fixture);
    jest
      .spyOn(WooCommerceClient.prototype, 'fetchOrder')
      .mockResolvedValue(wooPayload('processing'));
    const update = jest.spyOn(WooCommerceClient.prototype, 'updateOrderStatus');
    fixture.assertActive
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new EntitlementInactiveException('SUSPENDED'));

    await expect(
      fixture.service.updateStatus({
        telegram: fixture.identity,
        ref,
        target: 'completed',
      })
    ).resolves.toMatchObject({ state: 'FAILED' });
    expect(update).not.toHaveBeenCalled();
  });

  it('denies MEMBER writes and revalidates authorization and active context', async () => {
    const fixture = createFixture(1);
    const list = await fixture.service.list({ telegram: fixture.identity });

    expect(
      await fixture.service.transitions({
        telegram: fixture.identity,
        ref: list.orders[0]!.ref,
      })
    ).toEqual({ state: 'FORBIDDEN_ROLE' });

    fixture.state.membershipDeleted = true;
    expect(
      await fixture.service.transitions({
        telegram: fixture.identity,
        ref: list.orders[0]!.ref,
      })
    ).toEqual({ state: 'UNAUTHORIZED' });

    fixture.state.membershipDeleted = false;
    fixture.state.storeCount = 0;
    expect(
      await fixture.service.transitions({
        telegram: fixture.identity,
        ref: list.orders[0]!.ref,
      })
    ).toEqual({ state: 'NO_ACTIVE_STORE' });

    const demoted = createFixture(1);
    const writeRef = await writeReference(demoted);
    demoted.state.membershipRole = MembershipRole.MEMBER;
    expect(
      await demoted.service.updateStatus({
        telegram: demoted.identity,
        ref: writeRef,
        target: 'completed',
      })
    ).toEqual({ state: 'FORBIDDEN_ROLE' });
  });

  it('rejects invalid, expired, wrong-purpose, and context-changed references', async () => {
    const fixture = createFixture(1);
    const ref = await writeReference(fixture);
    const tampered = `${ref.slice(0, -1)}${ref.endsWith('A') ? 'B' : 'A'}`;

    expect(
      await fixture.service.updateStatus({
        telegram: fixture.identity,
        ref: tampered,
        target: 'completed',
      })
    ).toEqual({ state: 'CONTEXT_CHANGED' });

    expect(
      await fixture.service.updateStatus({
        telegram: fixture.identity,
        ref,
        target: 'made-up',
      })
    ).toEqual({ state: 'INVALID_TARGET' });

    const statusReference = fixture.references.find(
      (candidate) => candidate.id === `tcr_${ref.split('.')[1]}`
    )!;
    statusReference.expiresAt = new Date(0);
    expect(
      await fixture.service.updateStatus({
        telegram: fixture.identity,
        ref,
        target: 'completed',
      })
    ).toMatchObject({
      state: 'EXPIRED_REF',
      order: { status: 'processing' },
    });

    const list = await fixture.service.list({ telegram: fixture.identity });
    expect(
      await fixture.service.updateStatus({
        telegram: fixture.identity,
        ref: list.orders[0]!.ref,
        target: 'completed',
      })
    ).toEqual({ state: 'CONTEXT_CHANGED' });

    const freshRef = await writeReference(fixture);
    fixture.state.activeStoreId = 'sto_changed';
    expect(
      await fixture.service.updateStatus({
        telegram: fixture.identity,
        ref: freshRef,
        target: 'completed',
      })
    ).toEqual({ state: 'CONTEXT_CHANGED' });
  });

  it('returns NOT_FOUND and DELETED without issuing status references', async () => {
    const missing = createFixture(1);
    missing.state.membershipRole = MembershipRole.OWNER;
    const missingList = await missing.service.list({
      telegram: missing.identity,
    });
    missing.orders.length = 0;
    expect(
      await missing.service.transitions({
        telegram: missing.identity,
        ref: missingList.orders[0]!.ref,
      })
    ).toEqual({ state: 'NOT_FOUND' });

    const deleted = createFixture(1);
    deleted.state.membershipRole = MembershipRole.ADMIN;
    const deletedList = await deleted.service.list({
      telegram: deleted.identity,
    });
    deleted.orders[0]!.remoteDeletedAt = new Date();
    expect(
      await deleted.service.transitions({
        telegram: deleted.identity,
        ref: deletedList.orders[0]!.ref,
      })
    ).toEqual({ state: 'DELETED' });
  });

  it('returns NO_OP without issuing a WooCommerce write', async () => {
    const fixture = createFixture(1);
    const ref = await writeReference(fixture);
    jest
      .spyOn(WooCommerceClient.prototype, 'fetchOrder')
      .mockResolvedValue(wooPayload('completed'));
    const update = jest.spyOn(WooCommerceClient.prototype, 'updateOrderStatus');

    const result = await fixture.service.updateStatus({
      telegram: fixture.identity,
      ref,
      target: 'completed',
    });

    expect(result).toMatchObject({
      state: 'NO_OP',
      order: { status: 'completed' },
    });
    expect(update).not.toHaveBeenCalled();
    expect(fixture.auditLogs).toHaveLength(0);
  });

  it('returns RETRYABLE without a false local status change when WooCommerce cannot be reconciled', async () => {
    const fixture = createFixture(1);
    const ref = await writeReference(fixture);
    jest
      .spyOn(WooCommerceClient.prototype, 'fetchOrder')
      .mockResolvedValueOnce(wooPayload('processing'))
      .mockRejectedValueOnce(new WooCommerceClientError('timeout'));
    jest
      .spyOn(WooCommerceClient.prototype, 'updateOrderStatus')
      .mockRejectedValue(new WooCommerceClientError('timeout'));

    const result = await fixture.service.updateStatus({
      telegram: fixture.identity,
      ref,
      target: 'completed',
    });

    expect(result).toEqual({ state: 'RETRYABLE' });
    expect(fixture.orders[0]!.status).toBe('processing');
    expect(fixture.auditLogs).toHaveLength(0);
  });

  it('reconciles a lost write response before reporting success', async () => {
    const fixture = createFixture(1);
    const ref = await writeReference(fixture);
    jest
      .spyOn(WooCommerceClient.prototype, 'fetchOrder')
      .mockResolvedValueOnce(wooPayload('processing'))
      .mockResolvedValueOnce(wooPayload('completed'));
    const update = jest
      .spyOn(WooCommerceClient.prototype, 'updateOrderStatus')
      .mockRejectedValue(new WooCommerceClientError('transport'));

    const result = await fixture.service.updateStatus({
      telegram: fixture.identity,
      ref,
      target: 'completed',
    });

    expect(result).toMatchObject({
      state: 'OK',
      order: { status: 'completed' },
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(fixture.orders[0]!.status).toBe('completed');
  });

  it('returns FAILED and preserves local status when WooCommerce rejects the write', async () => {
    const fixture = createFixture(1);
    const ref = await writeReference(fixture);
    jest
      .spyOn(WooCommerceClient.prototype, 'fetchOrder')
      .mockResolvedValue(wooPayload('processing'));
    jest
      .spyOn(WooCommerceClient.prototype, 'updateOrderStatus')
      .mockRejectedValue(new WooCommerceClientError('auth'));

    const result = await fixture.service.updateStatus({
      telegram: fixture.identity,
      ref,
      target: 'completed',
    });

    expect(result).toEqual({ state: 'FAILED' });
    expect(fixture.orders[0]!.status).toBe('processing');
    expect(fixture.auditLogs).toHaveLength(0);
  });
});

describe('M17 order lookup, refresh, context, and notes', () => {
  async function detailReference(
    fixture: ReturnType<typeof createFixture>
  ): Promise<string> {
    const list = await fixture.service.list({ telegram: fixture.identity });
    return list.orders[0]!.ref;
  }

  async function preparedNote(
    fixture: ReturnType<typeof createFixture>,
    visibility: TelegramOrderNoteVisibility,
    note = 'Pack this order carefully.'
  ): Promise<string> {
    const detailRef = await detailReference(fixture);
    const started = await fixture.service.startNote({
      telegram: fixture.identity,
      ref: detailRef,
      visibility,
    });
    expect(started).toMatchObject({
      state: 'OK',
      inputRef: expect.stringMatching(/^i\./),
    });
    const prepared = await fixture.service.prepareNote({
      telegram: fixture.identity,
      ref: started.inputRef!,
      note,
    });
    expect(prepared).toMatchObject({
      state: 'OK',
      confirmRef: expect.stringMatching(/^c\./),
      preview: note,
    });
    return prepared.confirmRef!;
  }

  it.each([MembershipRole.OWNER, MembershipRole.ADMIN, MembershipRole.MEMBER])(
    'performs exact current-Store lookup for %s readers and reuses M11 detail',
    async (role) => {
      const fixture = createFixture(1);
      fixture.state.membershipRole = role;
      fixture.orders.push(
        makeOrder(91, {
          tenantId: 'ten_b',
          storeId: 'sto_b',
          orderNumber: '1001',
        })
      );

      const result = await fixture.service.lookup({
        telegram: fixture.identity,
        orderNumber: '1001',
      });

      expect(result).toMatchObject({
        state: 'OK',
        order: { orderNumber: '1001' },
        refreshRef: expect.stringMatching(/^d\./),
      });
      if (role === MembershipRole.MEMBER) {
        expect(result).not.toHaveProperty('addNoteRef');
      } else {
        expect(result).toHaveProperty('addNoteRef', result.refreshRef);
      }
      expect(fixture.prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: 'ten_a',
            storeId: 'sto_a',
            orderNumber: '1001',
          }),
          take: 2,
        })
      );
    }
  );

  it('fails malformed, missing, and ambiguous exact lookup safely', async () => {
    const fixture = createFixture(1);

    await expect(
      fixture.service.lookup({
        telegram: fixture.identity,
        orderNumber: '1001 other',
      })
    ).resolves.toMatchObject({ state: 'MALFORMED_ORDER_NUMBER' });
    await expect(
      fixture.service.lookup({
        telegram: fixture.identity,
        orderNumber: '9999',
      })
    ).resolves.toMatchObject({ state: 'NOT_FOUND' });

    fixture.orders.push(
      makeOrder(2, { wcOrderId: '9998', orderNumber: '1001' })
    );
    await expect(
      fixture.service.lookup({
        telegram: fixture.identity,
        orderNumber: '1001',
      })
    ).resolves.toMatchObject({ state: 'AMBIGUOUS' });
  });

  it('does not resolve an exact order number from another tenant or Store', async () => {
    const fixture = createFixture(0);
    fixture.orders.push(
      makeOrder(1, {
        tenantId: 'ten_foreign',
        storeId: 'sto_foreign',
        orderNumber: '1001',
      }),
      makeOrder(2, {
        tenantId: 'ten_a',
        storeId: 'sto_foreign',
        orderNumber: '1001',
      })
    );

    await expect(
      fixture.service.lookup({
        telegram: fixture.identity,
        orderNumber: '1001',
      })
    ).resolves.toMatchObject({ state: 'NOT_FOUND' });

    expect(fixture.prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'ten_a',
          storeId: 'sto_a',
          orderNumber: '1001',
        }),
      })
    );
  });

  it('rejects a detail reference after the active Store context changes without refreshing', async () => {
    const fixture = createFixture(1);
    const detailRef = await detailReference(fixture);
    const fetchOrder = jest.spyOn(WooCommerceClient.prototype, 'fetchOrder');
    fixture.state.activeStoreId = 'sto_changed';

    await expect(
      fixture.service.refresh({
        telegram: fixture.identity,
        ref: detailRef,
      })
    ).resolves.toMatchObject({ state: 'CONTEXT_CHANGED' });
    expect(fetchOrder).not.toHaveBeenCalled();
    expect(
      fixture.projection.reconcileAuthoritativeOrder
    ).not.toHaveBeenCalled();
  });

  it('exposes minimized payment and fulfillment context without contact or transaction data', async () => {
    const fixture = createFixture(1);
    const result = await fixture.service.detail({
      telegram: fixture.identity,
      ref: await detailReference(fixture),
    });

    expect(result).toMatchObject({
      state: 'OK',
      order: {
        payment: { method: 'Cash on delivery', paid: false },
        shipping: {
          methods: ['Flat rate'],
          addressLines: ['Fulfillment Street 1', 'Tehran, 12345', 'IR'],
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /must-not-leak|transaction|email|phone/i
    );
  });

  it('renders migration-backfilled empty payment and shipping snapshots safely', async () => {
    const fixture = createFixture(1);
    fixture.orders[0]!.paymentSnapshot = {} as TestOrder['paymentSnapshot'];
    fixture.orders[0]!.shippingLinesSnapshot = [];
    delete fixture.orders[0]!.customerSnapshot.shipping;

    const result = await fixture.service.detail({
      telegram: fixture.identity,
      ref: await detailReference(fixture),
    });

    expect(result).toMatchObject({
      state: 'OK',
      order: {
        payment: { method: null, paid: false },
        shipping: { methods: [], addressLines: [] },
      },
    });
  });

  it('refreshes with one logical bounded fetch and only M9 authoritative reconciliation', async () => {
    const fixture = createFixture(1);
    fixture.state.membershipRole = MembershipRole.MEMBER;
    const detailRef = await detailReference(fixture);
    const fetchOrder = jest
      .spyOn(WooCommerceClient.prototype, 'fetchOrder')
      .mockResolvedValue(wooPayload('completed'));

    const result = await fixture.service.refresh({
      telegram: fixture.identity,
      ref: detailRef,
    });

    expect(result.state).toBe('OK');
    expect(fetchOrder).toHaveBeenCalledTimes(1);
    expect(fetchOrder).toHaveBeenCalledWith('1001');
    expect(
      fixture.projection.reconcileAuthoritativeOrder
    ).toHaveBeenCalledTimes(1);
    expect(fixture.projection.reconcileAuthoritativeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sto_a' }),
      expect.any(Object),
      '1001'
    );
  });

  it.each<[WooCommerceClientError, 'RETRYABLE' | 'NOT_FOUND' | 'FAILED']>([
    [new WooCommerceClientError('timeout'), 'RETRYABLE'],
    [new WooCommerceClientError('not-found'), 'NOT_FOUND'],
    [new WooCommerceClientError('auth'), 'FAILED'],
  ])('normalizes refresh failure %s as %s', async (error, state) => {
    const fixture = createFixture(1);
    jest
      .spyOn(WooCommerceClient.prototype, 'fetchOrder')
      .mockRejectedValue(error);

    await expect(
      fixture.service.refresh({
        telegram: fixture.identity,
        ref: await detailReference(fixture),
      })
    ).resolves.toMatchObject({ state });
  });

  it.each<
    [Exclude<MembershipRole, 'MEMBER'>, TelegramOrderNoteVisibility, boolean]
  >([
    [MembershipRole.OWNER, TelegramOrderNoteVisibility.INTERNAL, false],
    [MembershipRole.ADMIN, TelegramOrderNoteVisibility.INTERNAL, false],
    [MembershipRole.OWNER, TelegramOrderNoteVisibility.CUSTOMER, true],
    [MembershipRole.ADMIN, TelegramOrderNoteVisibility.CUSTOMER, true],
  ])(
    'creates one %s %s note with WooCommerce visibility %s and safe audit',
    async (role, visibility, customerNote) => {
      const fixture = createFixture(1);
      fixture.state.membershipRole = role;
      jest
        .spyOn(WooCommerceClient.prototype, 'fetchOrder')
        .mockResolvedValue(wooPayload('processing'));
      const createNote = jest
        .spyOn(WooCommerceClient.prototype, 'createOrderNote')
        .mockResolvedValue({ id: 501, customer_note: customerNote });
      const confirmRef = await preparedNote(fixture, visibility);

      const first = await fixture.service.confirmNote({
        telegram: fixture.identity,
        ref: confirmRef,
      });
      const replay = await fixture.service.confirmNote({
        telegram: fixture.identity,
        ref: confirmRef,
      });

      expect(first).toMatchObject({ state: 'OK', visibility });
      expect(replay).toEqual(first);
      expect(createNote).toHaveBeenCalledTimes(1);
      expect(createNote).toHaveBeenCalledWith(
        '1001',
        'Pack this order carefully.',
        customerNote
      );
      expect(fixture.noteActions).toHaveLength(1);
      expect(fixture.auditLogs).toHaveLength(1);
      expect(fixture.auditLogs[0]).toMatchObject({
        action: 'telegram.order.note.created',
        entityType: 'Order',
        entityId: '1001',
        metadata: { visibility, result: 'SUCCEEDED' },
      });
      expect(JSON.stringify(fixture.auditLogs)).not.toContain(
        'Pack this order carefully.'
      );
    }
  );

  it('revalidates entitlement immediately before a claimed note write', async () => {
    const fixture = createFixture(1);
    fixture.state.membershipRole = MembershipRole.OWNER;
    jest
      .spyOn(WooCommerceClient.prototype, 'fetchOrder')
      .mockResolvedValue(wooPayload('processing'));
    const createNote = jest.spyOn(
      WooCommerceClient.prototype,
      'createOrderNote'
    );
    const confirmRef = await preparedNote(
      fixture,
      TelegramOrderNoteVisibility.INTERNAL
    );
    fixture.assertActive
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new EntitlementInactiveException('EXPIRED'));

    await expect(
      fixture.service.confirmNote({
        telegram: fixture.identity,
        ref: confirmRef,
      })
    ).resolves.toMatchObject({ state: 'FAILED' });
    expect(createNote).not.toHaveBeenCalled();
  });

  it('never exposes or allows a MEMBER note mutation path', async () => {
    const fixture = createFixture(1);
    fixture.state.membershipRole = MembershipRole.MEMBER;
    const detailRef = await detailReference(fixture);
    const detail = await fixture.service.detail({
      telegram: fixture.identity,
      ref: detailRef,
    });

    expect(detail).not.toHaveProperty('addNoteRef');
    await expect(
      fixture.service.noteOptions({
        telegram: fixture.identity,
        ref: detailRef,
      })
    ).resolves.toEqual({ state: 'FORBIDDEN_ROLE' });
    expect(
      fixture.prisma.telegramOrderNoteAction.create
    ).not.toHaveBeenCalled();
  });

  it('persists ambiguous note outcomes and never blindly redispatches them', async () => {
    const fixture = createFixture(1);
    fixture.state.membershipRole = MembershipRole.OWNER;
    jest
      .spyOn(WooCommerceClient.prototype, 'fetchOrder')
      .mockResolvedValue(wooPayload('processing'));
    const createNote = jest
      .spyOn(WooCommerceClient.prototype, 'createOrderNote')
      .mockRejectedValue(new WooCommerceClientError('timeout'));
    const confirmRef = await preparedNote(
      fixture,
      TelegramOrderNoteVisibility.CUSTOMER
    );

    const first = await fixture.service.confirmNote({
      telegram: fixture.identity,
      ref: confirmRef,
    });
    const replay = await fixture.service.confirmNote({
      telegram: fixture.identity,
      ref: confirmRef,
    });

    expect(first).toMatchObject({ state: 'AMBIGUOUS' });
    expect(replay).toEqual(first);
    expect(createNote).toHaveBeenCalledTimes(1);
    expect(fixture.auditLogs).toHaveLength(0);
  });

  it('allows only one note POST under simultaneous duplicate confirmation', async () => {
    const fixture = createFixture(1);
    fixture.state.membershipRole = MembershipRole.OWNER;
    jest
      .spyOn(WooCommerceClient.prototype, 'fetchOrder')
      .mockResolvedValue(wooPayload('processing'));
    let releasePost!: (value: { id: number; customer_note: boolean }) => void;
    let markDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      markDispatched = resolve;
    });
    const postResult = new Promise<{ id: number; customer_note: boolean }>(
      (resolve) => {
        releasePost = resolve;
      }
    );
    const createNote = jest
      .spyOn(WooCommerceClient.prototype, 'createOrderNote')
      .mockImplementation(async () => {
        markDispatched();
        return postResult;
      });
    const confirmRef = await preparedNote(
      fixture,
      TelegramOrderNoteVisibility.INTERNAL
    );

    const first = fixture.service.confirmNote({
      telegram: fixture.identity,
      ref: confirmRef,
    });
    await dispatched;
    const concurrent = await fixture.service.confirmNote({
      telegram: fixture.identity,
      ref: confirmRef,
    });
    releasePost({ id: 501, customer_note: false });

    await expect(first).resolves.toMatchObject({ state: 'OK' });
    expect(concurrent).toMatchObject({ state: 'IN_PROGRESS' });
    expect(createNote).toHaveBeenCalledTimes(1);
    expect(fixture.noteActions).toHaveLength(1);
    expect(fixture.auditLogs).toHaveLength(1);
  });

  it('persists a rate-limited post-dispatch result and does not retry it on replay', async () => {
    const fixture = createFixture(1);
    fixture.state.membershipRole = MembershipRole.OWNER;
    jest
      .spyOn(WooCommerceClient.prototype, 'fetchOrder')
      .mockResolvedValue(wooPayload('processing'));
    const createNote = jest
      .spyOn(WooCommerceClient.prototype, 'createOrderNote')
      .mockRejectedValue(new WooCommerceClientError('rate-limited'));
    const confirmRef = await preparedNote(
      fixture,
      TelegramOrderNoteVisibility.INTERNAL
    );

    const first = await fixture.service.confirmNote({
      telegram: fixture.identity,
      ref: confirmRef,
    });
    const replay = await fixture.service.confirmNote({
      telegram: fixture.identity,
      ref: confirmRef,
    });

    expect(first).toMatchObject({ state: 'RETRYABLE' });
    expect(replay).toEqual(first);
    expect(createNote).toHaveBeenCalledTimes(1);
  });

  it('converts a stale restart-surviving note claim to AMBIGUOUS without dispatch', async () => {
    const fixture = createFixture(1);
    fixture.state.membershipRole = MembershipRole.OWNER;
    const confirmRef = await preparedNote(
      fixture,
      TelegramOrderNoteVisibility.INTERNAL
    );
    const callbackReferenceId = `tcr_${confirmRef.split('.')[1]}`;
    fixture.noteActions.push({
      id: 'tona_stale',
      callbackReferenceId,
      visibility: TelegramOrderNoteVisibility.INTERNAL,
      state: TelegramOrderNoteActionState.IN_FLIGHT,
      startedAt: new Date(Date.now() - 61_000),
    });
    const createNote = jest.spyOn(
      WooCommerceClient.prototype,
      'createOrderNote'
    );

    const result = await fixture.service.confirmNote({
      telegram: fixture.identity,
      ref: confirmRef,
    });

    expect(result).toMatchObject({ state: 'AMBIGUOUS' });
    expect(createNote).not.toHaveBeenCalled();
    expect(fixture.noteActions[0]!.state).toBe(
      TelegramOrderNoteActionState.AMBIGUOUS
    );
  });

  it('requires plain bounded text and rejects expired or context-changed note references', async () => {
    const fixture = createFixture(1);
    fixture.state.membershipRole = MembershipRole.OWNER;
    const detailRef = await detailReference(fixture);
    const started = await fixture.service.startNote({
      telegram: fixture.identity,
      ref: detailRef,
      visibility: TelegramOrderNoteVisibility.INTERNAL,
    });

    await expect(
      fixture.service.prepareNote({
        telegram: fixture.identity,
        ref: started.inputRef!,
        note: '<script>unsafe</script>',
      })
    ).resolves.toMatchObject({ state: 'INVALID_NOTE' });

    const reference = fixture.references.find(
      (candidate) => candidate.id === `tcr_${started.inputRef!.split('.')[1]}`
    )!;
    reference.expiresAt = new Date(0);
    await expect(
      fixture.service.prepareNote({
        telegram: fixture.identity,
        ref: started.inputRef!,
        note: 'Safe text',
      })
    ).resolves.toEqual({ state: 'EXPIRED_REF' });

    const fresh = await fixture.service.startNote({
      telegram: fixture.identity,
      ref: detailRef,
      visibility: TelegramOrderNoteVisibility.INTERNAL,
    });
    fixture.state.activeStoreId = 'sto_changed';
    await expect(
      fixture.service.prepareNote({
        telegram: fixture.identity,
        ref: fresh.inputRef!,
        note: 'Safe text',
      })
    ).resolves.toEqual({ state: 'CONTEXT_CHANGED' });
  });

  it('blocks a prepared draft immediately after authorization is revoked', async () => {
    const fixture = createFixture(1);
    fixture.state.membershipRole = MembershipRole.ADMIN;
    jest
      .spyOn(WooCommerceClient.prototype, 'fetchOrder')
      .mockResolvedValue(wooPayload('processing'));
    const createNote = jest.spyOn(
      WooCommerceClient.prototype,
      'createOrderNote'
    );
    const confirmRef = await preparedNote(
      fixture,
      TelegramOrderNoteVisibility.CUSTOMER,
      'این یادداشت برای مشتری است.'
    );
    fixture.state.chatRevoked = true;

    await expect(
      fixture.service.confirmNote({
        telegram: fixture.identity,
        ref: confirmRef,
      })
    ).resolves.toEqual({ state: 'UNAUTHORIZED' });
    expect(createNote).not.toHaveBeenCalled();
    expect(fixture.noteActions).toHaveLength(0);
  });

  it('binds prepared visibility server-side and rejects a switched confirmation token', async () => {
    const fixture = createFixture(1);
    fixture.state.membershipRole = MembershipRole.OWNER;
    jest
      .spyOn(WooCommerceClient.prototype, 'fetchOrder')
      .mockResolvedValue(wooPayload('processing'));
    const createNote = jest
      .spyOn(WooCommerceClient.prototype, 'createOrderNote')
      .mockResolvedValue({ id: 501, customer_note: false });
    const confirmRef = await preparedNote(
      fixture,
      TelegramOrderNoteVisibility.INTERNAL
    );

    await expect(
      fixture.service.confirmNote({
        telegram: fixture.identity,
        ref: `${confirmRef}:CUSTOMER`,
      })
    ).resolves.toEqual({ state: 'CONTEXT_CHANGED' });
    await expect(
      fixture.service.confirmNote({
        telegram: fixture.identity,
        ref: confirmRef,
      })
    ).resolves.toMatchObject({
      state: 'OK',
      visibility: TelegramOrderNoteVisibility.INTERNAL,
    });
    expect(createNote).toHaveBeenCalledTimes(1);
    expect(createNote).toHaveBeenCalledWith(
      '1001',
      'Pack this order carefully.',
      false
    );
  });

  it('cancels a draft without any WooCommerce mutation', async () => {
    const fixture = createFixture(1);
    fixture.state.membershipRole = MembershipRole.ADMIN;
    const detailRef = await detailReference(fixture);
    const started = await fixture.service.startNote({
      telegram: fixture.identity,
      ref: detailRef,
      visibility: TelegramOrderNoteVisibility.INTERNAL,
    });
    const createNote = jest.spyOn(
      WooCommerceClient.prototype,
      'createOrderNote'
    );

    await expect(
      fixture.service.cancelNote({
        telegram: fixture.identity,
        ref: started.inputRef!,
      })
    ).resolves.toMatchObject({ state: 'CANCELLED', detailRef });
    expect(createNote).not.toHaveBeenCalled();
    expect(fixture.noteActions).toHaveLength(0);
  });
});
