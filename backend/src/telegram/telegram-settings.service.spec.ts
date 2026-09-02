import { describe, expect, it, jest } from '@jest/globals';
import {
  InventoryAlertClassification,
  InventorySyncState,
  MembershipRole,
  NotificationCategory,
  NotificationRecipientMode,
  Prisma,
  TenantLanguage,
} from '@prisma/client';

import type { ApplicationConfigService } from '../config/application-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TelegramOrderService } from './telegram-order.service';
import {
  canonicalTimezone,
  TelegramSettingsService,
} from './telegram-settings.service';

interface MembershipRow {
  id: string;
  tenantId: string;
  userId: string;
  role: MembershipRole;
  deletedAt: Date | null;
  user: { displayName: string | null };
}

function fixture() {
  const state = {
    actorRole: MembershipRole.OWNER as MembershipRole,
    activeStoreId: 'sto_a',
    accountDeleted: false,
    chatRevoked: false,
    tenant: {
      id: 'ten_a',
      timezone: 'UTC',
      language: TenantLanguage.EN,
      deletedAt: null as Date | null,
    },
    store: {
      id: 'sto_a',
      tenantId: 'ten_a',
      lowStockThreshold: null as number | null,
      enabledNotificationCategories: [
        NotificationCategory.ORDER_CREATED,
      ] as NotificationCategory[],
      notificationRecipientMode: NotificationRecipientMode.ALL_ELIGIBLE,
      inventoryNotificationPolicyVersion: 0,
      inventorySyncState: InventorySyncState.READY,
    },
    inventoryItems: [] as Array<{
      displayName: string;
      managesStock: boolean;
      stockQuantity: number | null;
      stockStatus: 'instock' | 'outofstock';
      remoteDeletedAt: Date | null;
      alertClassification: InventoryAlertClassification;
      incidentGeneration: number;
      lowAlertSourceWebhookEventId: string | null;
      lowAlertRecipientsCapturedAt: Date | null;
      outAlertSourceWebhookEventId: string | null;
      outAlertRecipientsCapturedAt: Date | null;
    }>,
    memberships: [
      {
        id: 'mem_actor',
        tenantId: 'ten_a',
        userId: 'usr_actor',
        role: MembershipRole.OWNER,
        deletedAt: null,
        user: { displayName: 'Owner مدیر' },
      },
      {
        id: 'mem_manager',
        tenantId: 'ten_a',
        userId: 'usr_manager',
        role: MembershipRole.MEMBER,
        deletedAt: null,
        user: { displayName: 'Warehouse Manager' },
      },
    ] as MembershipRow[],
    selected: new Set<string>(),
    eligible: new Set(['mem_actor', 'mem_manager']),
  };
  const references = new Map<string, Record<string, unknown>>();
  const auditLogs: Array<Record<string, unknown>> = [];
  const rawQueries: Prisma.Sql[] = [];
  const prisma = {
    telegramAccount: {
      findUnique: jest.fn(async () => ({
        id: 'tga_actor',
        userId: 'usr_actor',
        deletedAt: state.accountDeleted ? new Date() : null,
        chatAuthorizations: state.chatRevoked
          ? []
          : [{ telegramAccountId: 'tga_actor' }],
      })),
    },
    membership: {
      findMany: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          if ('userId' in where) {
            const actor = state.memberships.find(
              (membership) => membership.id === 'mem_actor'
            );
            return actor && !actor.deletedAt
              ? [
                  {
                    id: actor.id,
                    tenantId: actor.tenantId,
                    role: state.actorRole,
                  },
                ]
              : [];
          }

          return state.memberships.filter(
            (membership) =>
              membership.tenantId === 'ten_a' && membership.deletedAt === null
          );
        }
      ),
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          const membership = state.memberships.find(
            (candidate) => candidate.id === where['id']
          );
          return membership &&
            membership.tenantId === where['tenantId'] &&
            membership.deletedAt === null
            ? { id: membership.id }
            : null;
        }
      ),
    },
    store: {
      findMany: jest.fn(async () => [{ id: state.activeStoreId }]),
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          where['id'] === state.store.id &&
          where['tenantId'] === state.store.tenantId &&
          state.activeStoreId === state.store.id
            ? {
                ...state.store,
                tenant: {
                  timezone: state.tenant.timezone,
                  language: state.tenant.language,
                },
                selectedNotificationRecipients: [...state.selected].map(
                  (membershipId) => ({
                    membershipId,
                    membership: state.memberships.find(
                      (membership) => membership.id === membershipId
                    )!,
                  })
                ),
              }
            : null
      ),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const policyVersion = data['inventoryNotificationPolicyVersion'];

        if (
          policyVersion &&
          typeof policyVersion === 'object' &&
          'increment' in policyVersion
        ) {
          state.store.inventoryNotificationPolicyVersion += Number(
            policyVersion.increment
          );
        }

        Object.assign(state.store, {
          ...data,
          inventoryNotificationPolicyVersion:
            state.store.inventoryNotificationPolicyVersion,
        });
        return { id: state.store.id };
      }),
    },
    tenant: {
      findFirst: jest.fn(async () =>
        state.tenant.deletedAt ? null : { ...state.tenant }
      ),
      update: jest.fn(
        async ({ data }: { data: Partial<typeof state.tenant> }) => {
          Object.assign(state.tenant, data);
          return { id: state.tenant.id };
        }
      ),
    },
    storeNotificationRecipient: {
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { storeId_membershipId: { membershipId: string } };
        }) =>
          state.selected.has(where.storeId_membershipId.membershipId)
            ? { id: `snr_${where.storeId_membershipId.membershipId}` }
            : null
      ),
      create: jest.fn(async ({ data }: { data: { membershipId: string } }) => {
        state.selected.add(data.membershipId);
        return { id: `snr_${data.membershipId}` };
      }),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        state.selected.delete(where.id.replace(/^snr_/, ''));
        return { id: where.id };
      }),
      count: jest.fn(async () => state.selected.size),
    },
    telegramSettingsReference: {
      createMany: jest.fn(
        async ({ data }: { data: Array<Record<string, unknown>> }) => {
          for (const reference of data) {
            references.set(String(reference['id']), {
              consumedAt: null,
              action: null,
              language: null,
              notificationCategory: null,
              desiredEnabled: null,
              recipientMode: null,
              targetMembershipId: null,
              ...reference,
            });
          }
          return { count: data.length };
        }
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          references.get(where.id) ?? null
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const reference = references.get(where.id);
          if (!reference || reference['consumedAt']) {
            return { count: 0 };
          }
          Object.assign(reference, data);
          return { count: 1 };
        }
      ),
    },
    auditLog: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        auditLogs.push(data);
        return { id: 'aud_test' };
      }),
    },
    $executeRaw: jest.fn(async (query: Prisma.Sql) => {
      rawQueries.push(query);
      const threshold =
        (query.values.find((value) => typeof value === 'number') as
          number | undefined) ?? null;
      let changed = 0;

      for (const item of state.inventoryItems) {
        if (item.remoteDeletedAt !== null) {
          continue;
        }

        const next =
          item.stockStatus === 'outofstock'
            ? InventoryAlertClassification.OUT_OF_STOCK
            : item.managesStock &&
                item.stockQuantity !== null &&
                threshold !== null &&
                item.stockQuantity <= threshold
              ? InventoryAlertClassification.LOW_STOCK
              : InventoryAlertClassification.HEALTHY;

        if (item.alertClassification === next) {
          continue;
        }

        if (
          item.alertClassification === InventoryAlertClassification.HEALTHY &&
          next !== InventoryAlertClassification.HEALTHY
        ) {
          item.incidentGeneration += 1;
        }
        item.alertClassification = next;
        item.lowAlertSourceWebhookEventId = null;
        item.lowAlertRecipientsCapturedAt = null;
        item.outAlertSourceWebhookEventId = null;
        item.outAlertRecipientsCapturedAt = null;
        changed += 1;
      }

      return changed;
    }),
    $transaction: jest.fn(
      async (operation: (transaction: typeof prisma) => Promise<unknown>) =>
        operation(prisma)
    ),
  };
  const telegramOrders = {
    eligibleNotificationRecipients: jest.fn(async () =>
      [...state.eligible].map((membershipId) => ({ membershipId }))
    ),
  };
  const service = new TelegramSettingsService(
    prisma as unknown as PrismaService,
    {
      telegram: {
        callbackSigningKey: 'settings-test-signing-key-at-least-32-chars',
        callbackRefTtlSeconds: 900,
      },
    } as ApplicationConfigService,
    telegramOrders as unknown as TelegramOrderService
  );
  const input = {
    telegram: { userId: '1001', chatId: '2001' },
  };

  return { state, references, auditLogs, rawQueries, service, input };
}

describe('M18 Telegram settings service', () => {
  it.each([MembershipRole.OWNER, MembershipRole.ADMIN, MembershipRole.MEMBER])(
    'allows %s to read current settings',
    async (role) => {
      const test = fixture();
      test.state.actorRole = role;

      const result = await test.service.summary(test.input);

      expect(result).toMatchObject({
        state: 'OK',
        settings: {
          language: TenantLanguage.EN,
          timezone: 'UTC',
          lowStockThreshold: null,
          enabledNotificationCategories: [NotificationCategory.ORDER_CREATED],
          recipientMode: NotificationRecipientMode.ALL_ELIGIBLE,
          editable: role !== MembershipRole.MEMBER,
        },
      });
      expect(Boolean(result.settings?.actions)).toBe(
        role !== MembershipRole.MEMBER
      );
    }
  );

  it('enforces MEMBER mutation denial even with a valid OWNER-issued reference', async () => {
    const test = fixture();
    const summary = await test.service.summary(test.input);
    const ref = summary.settings!.actions!.languages.find(
      (item) => item.language === TenantLanguage.FA
    )!.ref;
    test.state.actorRole = MembershipRole.MEMBER;

    await expect(
      test.service.applyAction({ ...test.input, ref })
    ).resolves.toEqual({ state: 'FORBIDDEN_ROLE' });
    expect(test.state.tenant.language).toBe(TenantLanguage.EN);
    expect(test.auditLogs).toHaveLength(0);
  });

  it.each([MembershipRole.OWNER, MembershipRole.ADMIN])(
    'allows %s to set language using idempotent desired state',
    async (role) => {
      const test = fixture();
      test.state.actorRole = role;
      const summary = await test.service.summary(test.input);
      const ref = summary.settings!.actions!.languages.find(
        (item) => item.language === TenantLanguage.FA
      )!.ref;

      await test.service.applyAction({ ...test.input, ref });
      await test.service.applyAction({ ...test.input, ref });

      expect(test.state.tenant.language).toBe(TenantLanguage.FA);
      expect(test.auditLogs).toHaveLength(1);
    }
  );

  it('validates and canonicalizes timezone without mutating invalid input', async () => {
    const test = fixture();
    const summary = await test.service.summary(test.input);
    const ref = summary.settings!.actions!.timezoneInputRef;

    await expect(
      test.service.applyInput({ ...test.input, ref, value: 'PST' })
    ).resolves.toEqual({ state: 'INVALID_VALUE' });
    expect(test.state.tenant.timezone).toBe('UTC');
    await expect(
      test.service.applyInput({ ...test.input, ref, value: 'Asia/Tehran' })
    ).resolves.toMatchObject({ state: 'OK' });
    expect(test.state.tenant.timezone).toBe('Asia/Tehran');
  });

  it('sets, rejects, and explicitly clears the threshold', async () => {
    const test = fixture();
    let summary = await test.service.summary(test.input);

    await expect(
      test.service.applyInput({
        ...test.input,
        ref: summary.settings!.actions!.thresholdInputRef,
        value: '-1',
      })
    ).resolves.toEqual({ state: 'INVALID_VALUE' });

    await test.service.applyInput({
      ...test.input,
      ref: summary.settings!.actions!.thresholdInputRef,
      value: '۵',
    });
    expect(test.state.store.lowStockThreshold).toBeNull();
    await expect(
      test.service.applyInput({
        ...test.input,
        ref: summary.settings!.actions!.thresholdInputRef,
        value: '1000001',
      })
    ).resolves.toEqual({ state: 'INVALID_VALUE' });

    summary = await test.service.summary(test.input);
    await test.service.applyInput({
      ...test.input,
      ref: summary.settings!.actions!.thresholdInputRef,
      value: '5',
    });
    expect(test.state.store.lowStockThreshold).toBe(5);

    summary = await test.service.summary(test.input);
    await test.service.applyAction({
      ...test.input,
      ref: summary.settings!.actions!.thresholdClearRef,
    });
    expect(test.state.store.lowStockThreshold).toBeNull();
  });

  it('sets a numeric threshold from null on a READY projection and rebaselines nullable managed and explicit out-of-stock items without alerts', async () => {
    const test = fixture();
    test.state.inventoryItems.push(
      {
        displayName: 'Threshold item',
        managesStock: true,
        stockQuantity: 3,
        stockStatus: 'instock',
        remoteDeletedAt: null,
        alertClassification: InventoryAlertClassification.HEALTHY,
        incidentGeneration: 0,
        lowAlertSourceWebhookEventId: null,
        lowAlertRecipientsCapturedAt: null,
        outAlertSourceWebhookEventId: null,
        outAlertRecipientsCapturedAt: null,
      },
      {
        displayName: 'Unnamed product',
        managesStock: true,
        stockQuantity: null,
        stockStatus: 'instock',
        remoteDeletedAt: null,
        alertClassification: InventoryAlertClassification.HEALTHY,
        incidentGeneration: 0,
        lowAlertSourceWebhookEventId: null,
        lowAlertRecipientsCapturedAt: null,
        outAlertSourceWebhookEventId: null,
        outAlertRecipientsCapturedAt: null,
      },
      {
        displayName: 'Explicit out-of-stock item',
        managesStock: false,
        stockQuantity: null,
        stockStatus: 'outofstock',
        remoteDeletedAt: null,
        alertClassification: InventoryAlertClassification.OUT_OF_STOCK,
        incidentGeneration: 1,
        lowAlertSourceWebhookEventId: null,
        lowAlertRecipientsCapturedAt: null,
        outAlertSourceWebhookEventId: null,
        outAlertRecipientsCapturedAt: null,
      }
    );
    const summary = await test.service.summary(test.input);

    await expect(
      test.service.applyInput({
        ...test.input,
        ref: summary.settings!.actions!.thresholdInputRef,
        value: '5',
      })
    ).resolves.toMatchObject({ state: 'OK' });

    expect(test.state.store.inventorySyncState).toBe(InventorySyncState.READY);
    expect(test.state.store.lowStockThreshold).toBe(5);
    expect(test.state.inventoryItems).toEqual([
      expect.objectContaining({
        alertClassification: InventoryAlertClassification.LOW_STOCK,
        incidentGeneration: 1,
        lowAlertSourceWebhookEventId: null,
        lowAlertRecipientsCapturedAt: null,
      }),
      expect.objectContaining({
        displayName: 'Unnamed product',
        alertClassification: InventoryAlertClassification.HEALTHY,
        incidentGeneration: 0,
      }),
      expect.objectContaining({
        alertClassification: InventoryAlertClassification.OUT_OF_STOCK,
        incidentGeneration: 1,
        outAlertSourceWebhookEventId: null,
        outAlertRecipientsCapturedAt: null,
      }),
    ]);
    expect(test.rawQueries).toHaveLength(1);
    expect(test.rawQueries[0]!.text).not.toContain('IS NOT NULL');
    expect(test.rawQueries[0]!.values).toEqual([5, 'ten_a', 'sto_a']);
    expect(test.auditLogs).toHaveLength(1);
  });

  it('uses absolute category actions and suppresses duplicate no-op audit', async () => {
    const test = fixture();
    test.state.store.enabledNotificationCategories = [
      NotificationCategory.ORDER_CREATED,
      NotificationCategory.LOW_STOCK,
    ];
    const summary = await test.service.summary(test.input);
    const category = summary.settings!.actions!.categories.find(
      (item) => item.category === NotificationCategory.ORDER_CREATED
    )!;

    await test.service.applyAction({ ...test.input, ref: category.disableRef });
    await test.service.applyAction({ ...test.input, ref: category.disableRef });

    expect(test.state.store.enabledNotificationCategories).toEqual([
      NotificationCategory.LOW_STOCK,
    ]);
    expect(test.auditLogs).toHaveLength(1);

    await test.service.applyAction({ ...test.input, ref: category.enableRef });
    await test.service.applyAction({ ...test.input, ref: category.enableRef });
    expect(test.state.store.enabledNotificationCategories).toEqual([
      NotificationCategory.LOW_STOCK,
      NotificationCategory.ORDER_CREATED,
    ]);
    expect(test.auditLogs).toHaveLength(2);
    expect(test.state.store.inventoryNotificationPolicyVersion).toBe(0);
  });

  it('consumes an input reference once and rejects stale replay without overwriting state', async () => {
    const test = fixture();
    const summary = await test.service.summary(test.input);
    const ref = summary.settings!.actions!.thresholdInputRef;

    await expect(
      test.service.applyInput({ ...test.input, ref, value: '5' })
    ).resolves.toMatchObject({ state: 'OK' });
    await expect(
      test.service.applyInput({ ...test.input, ref, value: '8' })
    ).resolves.toEqual({ state: 'EXPIRED_REF' });

    expect(test.state.store.lowStockThreshold).toBe(5);
    expect(test.auditLogs).toHaveLength(1);
  });

  it('rejects wrong-purpose and signature-substituted settings references', async () => {
    const test = fixture();
    const summary = await test.service.summary(test.input);
    const timezoneRef = summary.settings!.actions!.timezoneInputRef;
    const languageRef = summary.settings!.actions!.languages[0]!.ref;
    const [languagePrefix, languageId] = languageRef.split('.');
    const timezoneSignature = timezoneRef.split('.')[2]!;

    await expect(
      test.service.applyAction({ ...test.input, ref: timezoneRef })
    ).resolves.toEqual({ state: 'CONTEXT_CHANGED' });
    await expect(
      test.service.applyInput({
        ...test.input,
        ref: languageRef,
        value: 'Asia/Tehran',
      })
    ).resolves.toEqual({ state: 'CONTEXT_CHANGED' });
    await expect(
      test.service.applyAction({
        ...test.input,
        ref: `${languagePrefix}.${languageId}.${timezoneSignature}`,
      })
    ).resolves.toEqual({ state: 'CONTEXT_CHANGED' });

    expect(test.state.tenant.language).toBe(TenantLanguage.EN);
    expect(test.state.tenant.timezone).toBe('UTC');
    expect(test.auditLogs).toHaveLength(0);
  });

  it('supports SELECTED with zero recipients and tenant-scoped add/remove', async () => {
    const test = fixture();
    let summary = await test.service.summary(test.input);
    const selectedMode = summary.settings!.actions!.recipientModes.find(
      (item) => item.mode === NotificationRecipientMode.SELECTED
    )!;
    await test.service.applyAction({ ...test.input, ref: selectedMode.ref });
    expect(test.state.store.notificationRecipientMode).toBe(
      NotificationRecipientMode.SELECTED
    );
    expect(test.state.selected.size).toBe(0);
    expect(test.state.store.inventoryNotificationPolicyVersion).toBe(1);

    summary = await test.service.summary(test.input);
    const manager = summary.settings!.recipients.find(
      (recipient) => recipient.displayName === 'Warehouse Manager'
    )!;
    await test.service.applyAction({ ...test.input, ref: manager.actionRef! });
    await test.service.applyAction({ ...test.input, ref: manager.actionRef! });
    expect(test.state.selected).toEqual(new Set(['mem_manager']));
    expect(test.state.store.inventoryNotificationPolicyVersion).toBe(2);

    summary = await test.service.summary(test.input);
    const remove = summary.settings!.recipients.find(
      (recipient) => recipient.displayName === 'Warehouse Manager'
    )!;
    await test.service.applyAction({ ...test.input, ref: remove.actionRef! });
    expect(test.state.selected.size).toBe(0);
    expect(test.state.store.inventoryNotificationPolicyVersion).toBe(3);
  });

  it('advances inventory notification policy only for real LOW_STOCK category changes', async () => {
    const test = fixture();
    let summary = await test.service.summary(test.input);
    let category = summary.settings!.actions!.categories.find(
      (item) => item.category === NotificationCategory.LOW_STOCK
    )!;

    await test.service.applyAction({ ...test.input, ref: category.enableRef });
    await test.service.applyAction({ ...test.input, ref: category.enableRef });
    expect(test.state.store.inventoryNotificationPolicyVersion).toBe(1);

    summary = await test.service.summary(test.input);
    category = summary.settings!.actions!.categories.find(
      (item) => item.category === NotificationCategory.LOW_STOCK
    )!;
    await test.service.applyAction({ ...test.input, ref: category.disableRef });
    expect(test.state.store.inventoryNotificationPolicyVersion).toBe(2);
  });

  it('preserves an unlinked selected Membership and renders it unavailable', async () => {
    const test = fixture();
    test.state.selected.add('mem_manager');
    test.state.eligible.delete('mem_manager');

    const summary = await test.service.summary(test.input);
    expect(summary.settings!.recipients).toContainEqual(
      expect.objectContaining({
        displayName: 'Warehouse Manager',
        selected: true,
        availability: 'UNAVAILABLE',
        action: 'REMOVE',
      })
    );
    expect(test.state.selected.has('mem_manager')).toBe(true);
  });

  it('fails a cross-tenant target and changed Store context without disclosure', async () => {
    const test = fixture();
    const summary = await test.service.summary(test.input);
    const managerRef = summary.settings!.recipients.find(
      (recipient) => recipient.displayName === 'Warehouse Manager'
    )!.actionRef!;
    const reference = [...test.references.values()].find(
      (candidate) => candidate['targetMembershipId'] === 'mem_manager'
    )!;
    reference['targetMembershipId'] = 'mem_foreign';
    await expect(
      test.service.applyAction({ ...test.input, ref: managerRef })
    ).resolves.toEqual({ state: 'CONTEXT_CHANGED' });
    expect(test.state.selected.size).toBe(0);

    const languageRef = summary.settings!.actions!.languages[0]!.ref;
    test.state.activeStoreId = 'sto_changed';
    await expect(
      test.service.applyAction({ ...test.input, ref: languageRef })
    ).resolves.toEqual({ state: 'CONTEXT_CHANGED' });
  });

  it('audits safe setting state without recipient identity or Telegram data', async () => {
    const test = fixture();
    const summary = await test.service.summary(test.input);
    const manager = summary.settings!.recipients.find(
      (recipient) => recipient.displayName === 'Warehouse Manager'
    )!;
    await test.service.applyAction({ ...test.input, ref: manager.actionRef! });

    const audit = JSON.stringify(test.auditLogs);
    expect(audit).toContain('recipientCount');
    expect(audit).not.toContain('mem_manager');
    expect(audit).not.toContain('Warehouse Manager');
    expect(audit).not.toContain('2001');
  });
});

describe('M18 timezone validation', () => {
  it.each([
    ['UTC', 'UTC'],
    [' Asia/Tehran ', 'Asia/Tehran'],
    ['America/New_York', 'America/New_York'],
    ['Europe/Paris', 'Europe/Paris'],
    ['asia/tehran', 'Asia/Tehran'],
  ])('accepts %s', (input, expected) => {
    expect(canonicalTimezone(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'PST',
    'GMT',
    'Invalid/Nowhere',
    'Asia Tehran',
    'A'.repeat(65),
  ])('rejects %s', (input) => {
    expect(canonicalTimezone(input)).toBeUndefined();
  });
});
