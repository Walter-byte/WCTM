import { describe, expect, it, jest } from '@jest/globals';
import {
  InventoryAlertLevel,
  TelegramInventoryNotificationState,
} from '@prisma/client';
import type { Job } from 'bullmq';

import type { TelegramInventoryService } from '../inventory/telegram-inventory.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TelegramDeliveryClient } from '../telegram/telegram-delivery.client';
import {
  type InventoryNotificationJobData,
  type InventoryNotificationJobResult,
  InventoryNotificationProcessor,
} from './inventory-notification.processor';
import { INVENTORY_NOTIFICATION_JOB_NAME } from './queue.constants';

type NotificationJob = Job<
  InventoryNotificationJobData,
  InventoryNotificationJobResult,
  typeof INVENTORY_NOTIFICATION_JOB_NAME
>;

function job(
  overrides: Partial<InventoryNotificationJobData> = {}
): NotificationJob {
  return {
    id: 'telegram-inventory-notification-tin_a',
    name: INVENTORY_NOTIFICATION_JOB_NAME,
    data: {
      deliveryId: 'tin_a',
      tenantId: 'ten_a',
      storeId: 'sto_a',
      ...overrides,
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as NotificationJob;
}

function setup(
  state: TelegramInventoryNotificationState = TelegramInventoryNotificationState.PENDING
) {
  const delivery = {
    id: 'tin_a',
    tenantId: 'ten_a',
    storeId: 'sto_a',
    state,
    attemptCount: 0,
    lastAttemptAt: null as Date | null,
    failureCategory: null as string | null,
    failureCode: null as string | null,
    telegramMessageId: null as bigint | null,
    deliveredAt: null as Date | null,
    createdAt: new Date('2026-09-01T08:00:00Z'),
    inventoryItemId: 'inv_a',
    incidentGeneration: 1,
    alertLevel: InventoryAlertLevel.LOW_STOCK,
    policyVersion: 0,
    telegramAccountId: 'tga_a',
    telegramChatAuthorizationId: 'tca_a',
    telegramAccount: { telegramUserId: BigInt(1001) },
    telegramChatAuthorization: {
      id: 'tca_a',
      telegramAccountId: 'tga_a',
      telegramChatId: BigInt(2001),
      revokedAt: null as Date | null,
      updatedAt: new Date('2026-09-01T07:59:00Z'),
    },
  };
  const updateMany = jest.fn(
    async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      if (
        where['id'] !== delivery.id ||
        where['tenantId'] !== delivery.tenantId ||
        where['storeId'] !== delivery.storeId
      ) {
        return { count: 0 };
      }

      const expected = where['state'];
      const matches =
        typeof expected === 'string'
          ? delivery.state === expected
          : expected && typeof expected === 'object' && 'in' in expected
            ? (expected.in as TelegramInventoryNotificationState[]).includes(
                delivery.state
              )
            : true;

      if (!matches) {
        return { count: 0 };
      }

      for (const [key, value] of Object.entries(data)) {
        if (
          key === 'attemptCount' &&
          value &&
          typeof value === 'object' &&
          'increment' in value
        ) {
          delivery.attemptCount += Number(value.increment);
        } else {
          Object.assign(delivery, { [key]: value });
        }
      }
      return { count: 1 };
    }
  );
  const findFirst = jest.fn(
    async ({ where }: { where: Record<string, unknown> }) =>
      where['id'] === delivery.id &&
      where['tenantId'] === delivery.tenantId &&
      where['storeId'] === delivery.storeId
        ? delivery
        : null
  );
  const prepareNotification = jest.fn<
    TelegramInventoryService['prepareNotification']
  >(async () => ({
    state: 'OK',
    displayName: 'Product\nOne',
    sku: 'SKU-1',
    quantity: '5',
    stockStatus: 'instock',
    classification: 'LOW_STOCK',
    threshold: 5,
    viewStockRef: `v.${'a'.repeat(16)}.${'b'.repeat(16)}`,
  }));
  const send = jest.fn<TelegramDeliveryClient['send']>(async () => ({
    outcome: 'delivered',
    messageId: '501',
  }));
  const processor = new InventoryNotificationProcessor(
    {
      telegramInventoryNotificationDelivery: { updateMany, findFirst },
    } as unknown as PrismaService,
    { prepareNotification } as unknown as TelegramInventoryService,
    { send } as unknown as TelegramDeliveryClient
  );

  return { delivery, prepareNotification, processor, send };
}

describe('M19 durable Telegram inventory delivery', () => {
  it('revalidates the current recipient and persists one confirmed send', async () => {
    const fixture = setup();

    await expect(fixture.processor.process(job())).resolves.toMatchObject({
      outcome: 'delivered',
    });

    expect(fixture.prepareNotification).toHaveBeenCalledWith(
      {
        telegramAccountId: 'tga_a',
        telegramChatAuthorizationId: 'tca_a',
        telegramUserId: '1001',
        telegramChatId: '2001',
      },
      'ten_a',
      'sto_a',
      'inv_a',
      1,
      InventoryAlertLevel.LOW_STOCK,
      0
    );
    expect(fixture.send).toHaveBeenCalledWith({
      chatId: '2001',
      presentation: { language: 'en', timezone: 'UTC' },
      notification: {
        type: 'LOW_STOCK',
        displayName: 'Product One',
        sku: 'SKU-1',
        quantity: '5',
        stockStatus: 'instock',
        threshold: 5,
        viewStockRef: `v.${'a'.repeat(16)}.${'b'.repeat(16)}`,
      },
    });
    expect(fixture.delivery.state).toBe(
      TelegramInventoryNotificationState.DELIVERED
    );
    expect(fixture.delivery.telegramMessageId).toBe(BigInt(501));
  });

  it('never resends a confirmed delivery', async () => {
    const fixture = setup(TelegramInventoryNotificationState.DELIVERED);

    await expect(fixture.processor.process(job())).resolves.toMatchObject({
      outcome: 'already_final',
    });
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('marks a lost in-flight outcome ambiguous without a blind resend', async () => {
    const fixture = setup(TelegramInventoryNotificationState.IN_FLIGHT);

    await expect(fixture.processor.process(job())).resolves.toMatchObject({
      outcome: 'ambiguous',
    });
    expect(fixture.delivery.state).toBe(
      TelegramInventoryNotificationState.AMBIGUOUS
    );
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('uses bounded retry only for a definitive retryable transport result', async () => {
    const fixture = setup();
    fixture.send.mockResolvedValueOnce({
      outcome: 'retryable_failure',
      category: 'rate-limited',
      code: 'telegram-rate-limited',
    });

    await expect(fixture.processor.process(job())).rejects.toThrow(
      'delivery is retryable'
    );
    expect(fixture.delivery.state).toBe(
      TelegramInventoryNotificationState.RETRYABLE_FAILURE
    );

    await fixture.processor.markFailed(job().data);
    expect(fixture.delivery.state).toBe(
      TelegramInventoryNotificationState.TERMINAL_FAILURE
    );
  });

  it.each(['UNAUTHORIZED', 'DISABLED', 'STALE'] as const)(
    'suppresses a pre-dispatch %s recipient or incident state terminally',
    async (state) => {
      const fixture = setup();
      fixture.prepareNotification.mockResolvedValueOnce({ state });

      await expect(fixture.processor.process(job())).resolves.toMatchObject({
        outcome: 'terminal_failure',
      });
      expect(fixture.send).not.toHaveBeenCalled();

      await expect(fixture.processor.process(job())).resolves.toMatchObject({
        outcome: 'already_final',
      });
      expect(fixture.prepareNotification).toHaveBeenCalledTimes(1);
    }
  );

  it('suppresses a captured delivery after unlink/relink changes the chat authorization', async () => {
    const fixture = setup();
    fixture.delivery.telegramChatAuthorization.updatedAt = new Date(
      '2026-09-01T08:01:00Z'
    );

    await expect(fixture.processor.process(job())).resolves.toMatchObject({
      outcome: 'terminal_failure',
    });
    expect(fixture.prepareNotification).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it.each(['terminal_failure', 'ambiguous'] as const)(
    'persists Telegram %s without retry',
    async (outcome) => {
      const fixture = setup();
      fixture.send.mockResolvedValueOnce({
        outcome,
        category: 'transport',
        code: 'bounded-safe-code',
      });

      await expect(fixture.processor.process(job())).resolves.toBeDefined();
      expect(fixture.delivery.state).toBe(
        outcome === 'ambiguous'
          ? TelegramInventoryNotificationState.AMBIGUOUS
          : TelegramInventoryNotificationState.TERMINAL_FAILURE
      );
    }
  );

  it('fails closed on cross-tenant and cross-Store job identities', async () => {
    const fixture = setup();

    await expect(
      fixture.processor.process(job({ tenantId: 'ten_b', storeId: 'sto_b' }))
    ).rejects.toMatchObject({ name: 'UnrecoverableError' });
    expect(fixture.prepareNotification).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
  });
});
