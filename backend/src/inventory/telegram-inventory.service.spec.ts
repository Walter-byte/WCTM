import { describe, expect, it, jest } from '@jest/globals';
import {
  InventoryAlertClassification,
  InventoryAlertLevel,
  InventoryItemKind,
  InventorySyncState,
  MembershipRole,
  NotificationCategory,
  NotificationRecipientMode,
} from '@prisma/client';

import type { ApplicationConfigService } from '../config/application-config.service';
import {
  EntitlementInactiveException,
  type EntitlementService,
} from '../entitlements/entitlement.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { InventoryBootstrapScheduler } from '../queue/inventory-bootstrap.scheduler';
import { TelegramInventoryService } from './telegram-inventory.service';

function inventoryItem(index: number) {
  return {
    id: `inv_${index}`,
    wcItemId: String(100 + index),
    displayName: `Product ${String(index).padStart(2, '0')}`,
    sku: index % 2 === 0 ? `SKU-${index}` : null,
    stockQuantity: { toString: () => String(index) },
    stockStatus:
      index < 2 ? 'outofstock' : index % 2 === 0 ? 'instock' : 'onbackorder',
    alertClassification:
      index < 2
        ? InventoryAlertClassification.OUT_OF_STOCK
        : InventoryAlertClassification.LOW_STOCK,
    kind: index === 2 ? InventoryItemKind.VARIATION : InventoryItemKind.PRODUCT,
    variationContext: index === 2 ? [{ name: 'Color', option: 'Blue' }] : [],
    lastSyncedAt: new Date('2026-09-01T08:00:00Z'),
    store: { lowStockThreshold: 5 },
  };
}

function setup(
  role: MembershipRole = MembershipRole.OWNER,
  initialization: {
    previousState: InventorySyncState;
    state: InventorySyncState;
  } = {
    previousState: InventorySyncState.READY,
    state: InventorySyncState.READY,
  }
) {
  const references: Array<Record<string, unknown>> = [];
  const records = Array.from({ length: 10 }, (_, index) =>
    inventoryItem(index + 1)
  );
  const findManyItems = jest.fn(
    async ({ skip, take }: { skip: number; take: number }) =>
      records.slice(skip, skip + take)
  );
  const findItem = jest.fn(
    async ({ where }: { where: Record<string, unknown> }) => {
      const item = records.find((candidate) => candidate.id === where['id']);
      return item ? { ...item } : null;
    }
  );
  const createManyReferences = jest.fn(
    async ({ data }: { data: Array<Record<string, unknown>> }) => {
      references.push(...data);
      return { count: data.length };
    }
  );
  const prisma = {
    telegramAccount: {
      findUnique: jest.fn(async () => ({
        id: 'tga_a',
        userId: 'usr_a',
        deletedAt: null,
        chatAuthorizations: [{ telegramAccountId: 'tga_a' }],
      })),
    },
    membership: {
      findMany: jest.fn(async ({ where }) =>
        (where.role.in as MembershipRole[]).includes(role)
          ? [{ id: 'mem_a', tenantId: 'ten_a' }]
          : []
      ),
    },
    store: {
      findMany: jest.fn(async () => [{ id: 'sto_a' }]),
      findFirst: jest.fn(async () => ({
        lowStockThreshold: 5,
        inventorySyncState: initialization.state,
        enabledNotificationCategories: [NotificationCategory.LOW_STOCK],
        notificationRecipientMode: NotificationRecipientMode.ALL_ELIGIBLE,
        inventoryNotificationPolicyVersion: 2,
        selectedNotificationRecipients: [],
      })),
    },
    inventoryItem: { findMany: findManyItems, findFirst: findItem },
    telegramInventoryReference: {
      createMany: createManyReferences,
      findUnique: jest.fn(
        async ({ where }) =>
          references.find((reference) => reference['id'] === where.id) ?? null
      ),
      findFirst: jest.fn(async ({ where }) =>
        references.find(
          (reference) =>
            reference['id'] === where.id &&
            reference['telegramAccountId'] === where.telegramAccountId &&
            reference['tenantId'] === where.tenantId &&
            reference['storeId'] === where.storeId
        )
          ? { id: where.id }
          : null
      ),
    },
  } as unknown as PrismaService;
  const ensureInitialized = jest.fn(async () => initialization);
  const assertActive = jest.fn(async () => undefined);
  const service = new TelegramInventoryService(
    prisma,
    {
      telegram: {
        callbackSigningKey: 'm19-callback-signing-key-at-least-32-characters',
        callbackRefTtlSeconds: 900,
      },
    } as ApplicationConfigService,
    { ensureInitialized } as unknown as InventoryBootstrapScheduler,
    { assertActive } as unknown as EntitlementService
  );
  const telegram = { userId: '1001', chatId: '2001' };

  return {
    createManyReferences,
    assertActive,
    ensureInitialized,
    findItem,
    findManyItems,
    references,
    service,
    telegram,
  };
}

describe('M19 /stock backend contract', () => {
  it('blocks inactive stock access before bootstrap or projection reads', async () => {
    const fixture = setup();
    fixture.assertActive.mockRejectedValueOnce(
      new EntitlementInactiveException('SUSPENDED')
    );

    await expect(
      fixture.service.list({ telegram: fixture.telegram })
    ).rejects.toBeInstanceOf(EntitlementInactiveException);
    expect(fixture.ensureInitialized).not.toHaveBeenCalled();
    expect(fixture.findManyItems).not.toHaveBeenCalled();
  });

  it.each([MembershipRole.OWNER, MembershipRole.ADMIN, MembershipRole.MEMBER])(
    'allows %s read access with Store-scoped eight-row pagination',
    async (role) => {
      const fixture = setup(role);

      const result = await fixture.service.list({ telegram: fixture.telegram });

      expect(result.state).toBe('OK');
      expect(result.items).toHaveLength(8);
      expect(result.nextCursor).toMatch(
        /^k\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/
      );
      expect(result.previousCursor).toBeNull();
      expect(JSON.stringify(result)).not.toContain('ten_a');
      expect(JSON.stringify(result)).not.toContain('sto_a');
      expect(fixture.findManyItems).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: 'ten_a',
            storeId: 'sto_a',
            remoteDeletedAt: null,
          }),
          skip: 0,
          take: 9,
        })
      );
    }
  );

  it('returns SYNCING without reading a partial projection', async () => {
    const fixture = setup(MembershipRole.OWNER, {
      previousState: InventorySyncState.UNINITIALIZED,
      state: InventorySyncState.SYNCING,
    });

    await expect(
      fixture.service.list({ telegram: fixture.telegram })
    ).resolves.toEqual({
      state: 'SYNCING',
      items: [],
      nextCursor: null,
      previousCursor: null,
      threshold: 5,
    });
    expect(fixture.ensureInitialized).toHaveBeenCalledWith('ten_a', 'sto_a');
    expect(fixture.findManyItems).not.toHaveBeenCalled();
  });

  it('reports a failed bootstrap safely while scheduling recovery', async () => {
    const fixture = setup(MembershipRole.OWNER, {
      previousState: InventorySyncState.FAILED,
      state: InventorySyncState.SYNCING,
    });

    await expect(
      fixture.service.list({ telegram: fixture.telegram })
    ).resolves.toMatchObject({ state: 'SYNC_FAILED', items: [] });
    expect(fixture.ensureInitialized).toHaveBeenCalledTimes(1);
    expect(fixture.findManyItems).not.toHaveBeenCalled();
  });

  it('validates signed page references and rejects tampering before data access', async () => {
    const fixture = setup();
    const first = await fixture.service.list({ telegram: fixture.telegram });
    expect(first.state).toBe('OK');
    const cursor = first.nextCursor!;

    const second = await fixture.service.list({
      telegram: fixture.telegram,
      cursor,
    });
    expect(second.state).toBe('OK');
    expect(fixture.findManyItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ skip: 8, take: 9 })
    );

    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
    await expect(
      fixture.service.list({ telegram: fixture.telegram, cursor: tampered })
    ).resolves.toMatchObject({ state: 'CONTEXT_CHANGED', items: [] });
  });

  it('opens a minimized read-only variation detail through a context-bound reference', async () => {
    const fixture = setup();
    const list = await fixture.service.list({ telegram: fixture.telegram });
    expect(list.state).toBe('OK');
    const variation = list.items.find((item) => item.kind === 'VARIATION');
    expect(variation).toBeDefined();

    const detail = await fixture.service.detail({
      telegram: fixture.telegram,
      ref: variation!.ref,
    });

    expect(detail).toEqual({
      state: 'OK',
      item: expect.objectContaining({
        displayName: 'Product 02',
        variationContext: [{ name: 'Color', option: 'Blue' }],
        threshold: 5,
        lastSyncedAt: '2026-09-01T08:00:00.000Z',
      }),
      backCursor: expect.stringMatching(
        /^k\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/
      ),
    });
    expect(JSON.stringify(detail)).not.toMatch(/description|price|customer/i);
  });

  it('suppresses a delivery captured under an older Store recipient-policy generation', async () => {
    const fixture = setup();

    await expect(
      fixture.service.prepareNotification(
        {
          membershipId: 'mem_a',
          telegramAccountId: 'tga_a',
          telegramChatAuthorizationId: 'tca_a',
          telegramUserId: '1001',
          telegramChatId: '2001',
        },
        'ten_a',
        'sto_a',
        'inv_1',
        1,
        InventoryAlertLevel.OUT_OF_STOCK,
        1
      )
    ).resolves.toEqual({ state: 'DISABLED' });
    expect(fixture.findItem).not.toHaveBeenCalled();
  });
});
