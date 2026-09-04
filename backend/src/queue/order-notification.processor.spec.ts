import { describe, expect, it, jest } from '@jest/globals';
import { TelegramOrderNotificationState } from '@prisma/client';
import type { Job } from 'bullmq';

import type { PrismaService } from '../prisma/prisma.service';
import type { EntitlementService } from '../entitlements/entitlement.service';
import type { TelegramDeliveryClient } from '../telegram/telegram-delivery.client';
import type { TelegramOrderService } from '../telegram/telegram-order.service';
import { ORDER_NOTIFICATION_JOB_NAME } from './queue.constants';
import {
  type OrderNotificationJobData,
  type OrderNotificationJobResult,
  OrderNotificationProcessor,
} from './order-notification.processor';

type NotificationJob = Job<
  OrderNotificationJobData,
  OrderNotificationJobResult,
  typeof ORDER_NOTIFICATION_JOB_NAME
>;

const job = (
  overrides: Partial<OrderNotificationJobData> = {}
): NotificationJob =>
  ({
    id: 'telegram-order-notification-ton_a',
    name: ORDER_NOTIFICATION_JOB_NAME,
    data: {
      deliveryId: 'ton_a',
      tenantId: 'ten_a',
      storeId: 'sto_a',
      ...overrides,
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
  }) as NotificationJob;

function setup(
  initialState: TelegramOrderNotificationState = TelegramOrderNotificationState.PENDING
) {
  const delivery = {
    id: 'ton_a',
    tenantId: 'ten_a',
    storeId: 'sto_a',
    state: initialState,
    attemptCount: 0,
    lastAttemptAt: null as Date | null,
    failureCategory: null as string | null,
    failureCode: null as string | null,
    telegramMessageId: null as bigint | null,
    deliveredAt: null as Date | null,
    telegramAccountId: 'tga_a',
    telegramChatAuthorizationId: 'tca_a',
    order: { wcOrderId: '101' },
    telegramAccount: { telegramUserId: BigInt(1001) },
    telegramChatAuthorization: {
      id: 'tca_a',
      telegramAccountId: 'tga_a',
      telegramChatId: BigInt(2001),
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

      const expectedState = where['state'];
      const stateMatches =
        typeof expectedState === 'string'
          ? expectedState === delivery.state
          : expectedState &&
              typeof expectedState === 'object' &&
              'in' in expectedState
            ? (expectedState.in as TelegramOrderNotificationState[]).includes(
                delivery.state
              )
            : true;

      if (!stateMatches) {
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
  const prepareOrderNotification = jest.fn<
    TelegramOrderService['prepareOrderNotification']
  >(async () => ({
    state: 'OK',
    orderNumber: '101\nsecret',
    status: 'processing',
    currency: 'IRR',
    total: '1000',
    customerDisplayName: 'Test\nCustomer',
    viewOrderRef: 'd.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBB',
    changeStatusAvailable: true,
  }));
  const send = jest.fn<TelegramDeliveryClient['send']>(async () => ({
    outcome: 'delivered',
    messageId: '501',
  }));
  const isActive = jest.fn(async () => true);
  const processor = new OrderNotificationProcessor(
    {
      telegramOrderNotificationDelivery: { updateMany, findFirst },
    } as unknown as PrismaService,
    { prepareOrderNotification } as unknown as TelegramOrderService,
    { send } as unknown as TelegramDeliveryClient,
    { isActive } as unknown as EntitlementService
  );

  return {
    delivery,
    processor,
    prepareOrderNotification,
    send,
    updateMany,
    isActive,
  };
}

describe('M13 durable notification delivery', () => {
  it('terminally suppresses before Telegram dispatch when entitlement becomes inactive', async () => {
    const fixture = setup();
    fixture.isActive.mockResolvedValue(false);

    await expect(fixture.processor.process(job())).resolves.toMatchObject({
      outcome: 'terminal_failure',
    });
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.delivery).toMatchObject({
      state: TelegramOrderNotificationState.TERMINAL_FAILURE,
      failureCode: 'entitlement-inactive',
    });

    fixture.isActive.mockResolvedValue(true);
    await expect(fixture.processor.process(job())).resolves.toMatchObject({
      outcome: 'already_final',
    });
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('revalidates after preparation and suppresses a last-moment suspension', async () => {
    const fixture = setup();
    fixture.isActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(fixture.processor.process(job())).resolves.toMatchObject({
      outcome: 'terminal_failure',
    });
    expect(fixture.prepareOrderNotification).toHaveBeenCalledTimes(1);
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.delivery.failureCode).toBe('entitlement-inactive');
  });

  it('resumes a pending delivery, revalidates context, and persists success', async () => {
    const fixture = setup();

    await expect(fixture.processor.process(job())).resolves.toMatchObject({
      outcome: 'delivered',
    });

    expect(fixture.prepareOrderNotification).toHaveBeenCalledWith(
      {
        telegramAccountId: 'tga_a',
        telegramChatAuthorizationId: 'tca_a',
        telegramUserId: '1001',
        telegramChatId: '2001',
      },
      'ten_a',
      'sto_a',
      '101'
    );
    expect(fixture.send).toHaveBeenCalledWith({
      chatId: '2001',
      presentation: { language: 'en', timezone: 'UTC' },
      notification: {
        type: 'ORDER_CREATED',
        orderNumber: '101 secret',
        status: 'processing',
        currency: 'IRR',
        total: '1000',
        customerDisplayName: 'Test Customer',
        viewOrderRef: 'd.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBB',
        changeStatusAvailable: true,
      },
    });
    expect(fixture.delivery.state).toBe(
      TelegramOrderNotificationState.DELIVERED
    );
    expect(fixture.delivery.attemptCount).toBe(1);
    expect(fixture.delivery.telegramMessageId).toBe(BigInt(501));
  });

  it('omits Change Status when the existing M12 capability is absent', async () => {
    const fixture = setup();
    fixture.prepareOrderNotification.mockResolvedValueOnce({
      state: 'OK',
      orderNumber: '101',
      status: 'processing',
      currency: 'IRR',
      total: '1000',
      customerDisplayName: 'Member',
      viewOrderRef: 'd.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBB',
      changeStatusAvailable: false,
    });

    await fixture.processor.process(job());

    expect(fixture.send.mock.calls[0]?.[0].notification.type).toBe(
      'ORDER_CREATED'
    );
    expect(
      fixture.send.mock.calls[0]?.[0].notification.type === 'ORDER_CREATED' &&
        fixture.send.mock.calls[0]?.[0].notification.changeStatusAvailable
    ).toBe(false);
  });

  it('never resends an already delivered record', async () => {
    const fixture = setup(TelegramOrderNotificationState.DELIVERED);

    await expect(fixture.processor.process(job())).resolves.toMatchObject({
      outcome: 'already_final',
    });
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('marks unresolved in-flight state ambiguous without a blind resend', async () => {
    const fixture = setup(TelegramOrderNotificationState.IN_FLIGHT);

    await expect(fixture.processor.process(job())).resolves.toMatchObject({
      outcome: 'ambiguous',
    });
    expect(fixture.delivery.state).toBe(
      TelegramOrderNotificationState.AMBIGUOUS
    );
    expect(fixture.delivery.failureCode).toBe('in-flight-outcome-unknown');
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('uses bounded retry only for a definitive retryable bot outcome', async () => {
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
      TelegramOrderNotificationState.RETRYABLE_FAILURE
    );

    await fixture.processor.markFailed(job().data);
    expect(fixture.delivery.state).toBe(
      TelegramOrderNotificationState.TERMINAL_FAILURE
    );
    expect(fixture.delivery.failureCode).toBe('telegram-retry-exhausted');
  });

  it.each([
    [
      'terminal_failure' as const,
      TelegramOrderNotificationState.TERMINAL_FAILURE,
    ],
    ['ambiguous' as const, TelegramOrderNotificationState.AMBIGUOUS],
  ])('persists %s bot outcomes without retry', async (outcome, state) => {
    const fixture = setup();
    fixture.send.mockResolvedValueOnce({
      outcome,
      category: 'transport',
      code: 'bounded-safe-code',
    });

    await expect(fixture.processor.process(job())).resolves.toBeDefined();
    expect(fixture.delivery.state).toBe(state);
    expect(fixture.delivery.failureCode).toBe('bounded-safe-code');
  });

  it('terminally skips a recipient revoked before dispatch', async () => {
    const fixture = setup();
    fixture.prepareOrderNotification.mockResolvedValueOnce({
      state: 'UNAUTHORIZED',
    });

    await expect(fixture.processor.process(job())).resolves.toMatchObject({
      outcome: 'terminal_failure',
    });
    expect(fixture.delivery.failureCategory).toBe('authorization');
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('terminally skips delivery when settings disable policy after scheduling', async () => {
    const fixture = setup();
    fixture.prepareOrderNotification.mockResolvedValueOnce({
      state: 'DISABLED',
    });

    await expect(fixture.processor.process(job())).resolves.toMatchObject({
      outcome: 'terminal_failure',
    });
    expect(fixture.delivery.failureCategory).toBe('policy');
    expect(fixture.delivery.failureCode).toBe('notification-disabled');
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('does not resurrect a policy-suppressed delivery after settings are re-enabled', async () => {
    const fixture = setup();
    fixture.prepareOrderNotification.mockResolvedValueOnce({
      state: 'DISABLED',
    });

    await fixture.processor.process(job());
    fixture.prepareOrderNotification.mockResolvedValueOnce({
      state: 'OK',
      orderNumber: '101',
      status: 'processing',
      currency: 'IRR',
      total: '1000',
      customerDisplayName: 'Manager',
      viewOrderRef: 'd.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBB',
      changeStatusAvailable: false,
    });

    await expect(fixture.processor.process(job())).resolves.toMatchObject({
      outcome: 'already_final',
    });
    expect(fixture.prepareOrderNotification).toHaveBeenCalledTimes(1);
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.delivery.state).toBe(
      TelegramOrderNotificationState.TERMINAL_FAILURE
    );
  });

  it('fails closed on tenant or Store job mismatch', async () => {
    const fixture = setup();

    await expect(
      fixture.processor.process(job({ tenantId: 'ten_b', storeId: 'sto_b' }))
    ).rejects.toMatchObject({ name: 'UnrecoverableError' });
    expect(fixture.prepareOrderNotification).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('persists only bounded classifications and no transport secrets', async () => {
    const fixture = setup();
    fixture.send.mockResolvedValueOnce({
      outcome: 'terminal_failure',
      category: 'request',
      code: 'telegram-request-rejected',
    });

    await fixture.processor.process(job());

    const persisted = JSON.stringify({
      category: fixture.delivery.failureCategory,
      code: fixture.delivery.failureCode,
    });
    expect(persisted).toBe(
      '{"category":"request","code":"telegram-request-rejected"}'
    );
    expect(persisted).not.toContain('BOT_INTERNAL_API_KEY');
    expect(persisted).not.toContain('authorization');
  });
});
