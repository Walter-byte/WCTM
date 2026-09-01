import { describe, expect, it, jest } from '@jest/globals';
import {
  InventoryAlertLevel,
  NotificationCategory,
  NotificationRecipientMode,
  TelegramInventoryNotificationState,
} from '@prisma/client';

import type { InventoryAlertSignal } from '../inventory/inventory-projection.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TelegramOrderService } from '../telegram/telegram-order.service';
import {
  inventoryNotificationJobId,
  InventoryNotificationScheduler,
} from './inventory-notification.scheduler';
import type { QueueRuntimeService } from './queue-runtime.service';

const signal = (
  level: InventoryAlertLevel = InventoryAlertLevel.LOW_STOCK
): InventoryAlertSignal => ({
  inventoryItemId: 'inv_a',
  incidentGeneration: 1,
  alertLevel: level,
  sourceWebhookEventId:
    level === InventoryAlertLevel.LOW_STOCK ? 'evt_low' : 'evt_out',
});

function setup(recipientCount: number) {
  const item = {
    id: 'inv_a',
    incidentGeneration: 1,
    lowAlertSourceWebhookEventId: 'evt_low',
    lowAlertRecipientsCapturedAt: null as Date | null,
    outAlertSourceWebhookEventId: 'evt_out',
    outAlertRecipientsCapturedAt: null as Date | null,
  };
  const policy = {
    enabledNotificationCategories: [
      NotificationCategory.LOW_STOCK,
    ] as NotificationCategory[],
    notificationRecipientMode:
      NotificationRecipientMode.ALL_ELIGIBLE as NotificationRecipientMode,
    inventoryNotificationPolicyVersion: 0,
    selectedNotificationRecipients: [] as Array<{ membershipId: string }>,
  };
  const recipients = Array.from({ length: recipientCount }, (_, index) => ({
    membershipId: `mem_${index + 1}`,
    telegramAccountId: `tga_${index + 1}`,
    telegramChatAuthorizationId: `tca_${index + 1}`,
    telegramUserId: String(1001 + index),
    telegramChatId: String(2001 + index),
  }));
  const deliveries: Array<Record<string, unknown>> = [];
  const transaction = {
    inventoryItem: {
      updateMany: jest.fn(async ({ where, data }) => {
        const isLow = where.lowAlertSourceWebhookEventId !== undefined;
        const captured = isLow
          ? item.lowAlertRecipientsCapturedAt
          : item.outAlertRecipientsCapturedAt;

        if (
          where.id !== item.id ||
          where.incidentGeneration !== item.incidentGeneration ||
          captured !== null
        ) {
          return { count: 0 };
        }

        Object.assign(item, data);
        return { count: 1 };
      }),
    },
    telegramInventoryNotificationDelivery: {
      createMany: jest.fn(async ({ data }) => {
        for (const candidate of data as Array<Record<string, unknown>>) {
          if (
            !deliveries.some(
              (delivery) =>
                delivery['inventoryItemId'] === candidate['inventoryItemId'] &&
                delivery['incidentGeneration'] ===
                  candidate['incidentGeneration'] &&
                delivery['alertLevel'] === candidate['alertLevel'] &&
                delivery['telegramChatAuthorizationId'] ===
                  candidate['telegramChatAuthorizationId']
            )
          ) {
            deliveries.push({
              ...candidate,
              state: TelegramInventoryNotificationState.PENDING,
            });
          }
        }
        return { count: data.length };
      }),
    },
  };
  const addInventoryNotificationJob = jest.fn(async () => ({ id: 'job' }));
  const eligibleNotificationRecipients = jest.fn(async () => recipients);
  const scheduler = new InventoryNotificationScheduler(
    {
      inventoryItem: { findFirst: jest.fn(async () => ({ ...item })) },
      store: { findFirst: jest.fn(async () => ({ ...policy })) },
      telegramInventoryNotificationDelivery: {
        findMany: jest.fn(async ({ where }) =>
          deliveries
            .filter(
              (delivery) =>
                delivery['inventoryItemId'] === where.inventoryItemId &&
                delivery['incidentGeneration'] === where.incidentGeneration &&
                delivery['alertLevel'] === where.alertLevel &&
                delivery['sourceWebhookEventId'] === where.sourceWebhookEventId
            )
            .map((delivery) => ({ id: delivery['id'] as string }))
        ),
      },
      $transaction: jest.fn(
        async (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction)
      ),
    } as unknown as PrismaService,
    { eligibleNotificationRecipients } as unknown as TelegramOrderService,
    { addInventoryNotificationJob } as unknown as QueueRuntimeService
  );

  return {
    addInventoryNotificationJob,
    deliveries,
    eligibleNotificationRecipients,
    item,
    policy,
    scheduler,
  };
}

describe('M19 durable inventory notification scheduling', () => {
  it('captures ALL_ELIGIBLE recipients once and enqueues deterministic deliveries', async () => {
    const fixture = setup(2);

    await fixture.scheduler.schedule('ten_a', 'sto_a', signal());

    expect(fixture.deliveries).toHaveLength(2);
    expect(fixture.deliveries).toEqual([
      expect.objectContaining({ policyVersion: 0 }),
      expect.objectContaining({ policyVersion: 0 }),
    ]);
    expect(fixture.item.lowAlertRecipientsCapturedAt).toBeInstanceOf(Date);
    expect(fixture.addInventoryNotificationJob).toHaveBeenCalledTimes(2);
    for (const delivery of fixture.deliveries) {
      expect(fixture.addInventoryNotificationJob).toHaveBeenCalledWith(
        {
          deliveryId: delivery['id'],
          tenantId: 'ten_a',
          storeId: 'sto_a',
        },
        inventoryNotificationJobId(delivery['id'] as string)
      );
    }
  });

  it('uses SELECTED as a strict intersection with current M10 eligibility', async () => {
    const fixture = setup(3);
    fixture.policy.notificationRecipientMode =
      NotificationRecipientMode.SELECTED;
    fixture.policy.selectedNotificationRecipients = [
      { membershipId: 'mem_2' },
      { membershipId: 'mem_not_authorized' },
    ];

    await fixture.scheduler.schedule('ten_a', 'sto_a', signal());

    expect(fixture.deliveries).toHaveLength(1);
    expect(fixture.deliveries[0]).toMatchObject({
      telegramAccountId: 'tga_2',
      telegramChatAuthorizationId: 'tca_2',
    });
  });

  it('captures zero selected recipients so later policy changes cannot resurrect the alert', async () => {
    const fixture = setup(2);
    fixture.policy.notificationRecipientMode =
      NotificationRecipientMode.SELECTED;

    await fixture.scheduler.schedule('ten_a', 'sto_a', signal());
    fixture.policy.notificationRecipientMode =
      NotificationRecipientMode.ALL_ELIGIBLE;
    await fixture.scheduler.schedule('ten_a', 'sto_a', signal());

    expect(fixture.deliveries).toHaveLength(0);
    expect(fixture.eligibleNotificationRecipients).toHaveBeenCalledTimes(1);
    expect(fixture.item.lowAlertRecipientsCapturedAt).toBeInstanceOf(Date);
  });

  it('does not resurrect an incident when LOW_STOCK is disabled then re-enabled', async () => {
    const fixture = setup(1);
    fixture.policy.enabledNotificationCategories = [];

    await fixture.scheduler.schedule('ten_a', 'sto_a', signal());
    fixture.policy.enabledNotificationCategories = [
      NotificationCategory.LOW_STOCK,
    ];
    await fixture.scheduler.schedule('ten_a', 'sto_a', signal());

    expect(fixture.deliveries).toHaveLength(0);
    expect(fixture.eligibleNotificationRecipients).not.toHaveBeenCalled();
    expect(fixture.addInventoryNotificationJob).not.toHaveBeenCalled();
  });

  it('keeps LOW and OUT escalation delivery identities separate within one incident', async () => {
    const fixture = setup(1);

    await fixture.scheduler.schedule('ten_a', 'sto_a', signal());
    await fixture.scheduler.schedule(
      'ten_a',
      'sto_a',
      signal(InventoryAlertLevel.OUT_OF_STOCK)
    );

    expect(fixture.deliveries).toHaveLength(2);
    expect(
      new Set(fixture.deliveries.map((delivery) => delivery['alertLevel']))
    ).toEqual(
      new Set([InventoryAlertLevel.LOW_STOCK, InventoryAlertLevel.OUT_OF_STOCK])
    );
  });
});
