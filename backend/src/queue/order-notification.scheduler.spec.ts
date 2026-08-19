import { describe, expect, it, jest } from '@jest/globals';

import type { ProjectableWebhookEvent } from '../orders/order-projection.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TelegramOrderService } from '../telegram/telegram-order.service';
import type { QueueRuntimeService } from './queue-runtime.service';
import {
  orderNotificationJobId,
  OrderNotificationScheduler,
} from './order-notification.scheduler';

const event = (): ProjectableWebhookEvent => ({
  id: 'evt_a',
  topic: 'order.created',
  payload: { id: 101 },
  receivedAt: new Date('2026-08-20T00:00:00.000Z'),
  store: {
    id: 'sto_a',
    tenantId: 'ten_a',
    baseUrl: 'https://shop.example',
    consumerKeyEncrypted: 'encrypted-key',
    consumerSecretEncrypted: 'encrypted-secret',
  },
});

function setup(recipientCount: number) {
  const recipients = Array.from({ length: recipientCount }, (_, index) => ({
    telegramAccountId: `tga_${index + 1}`,
    telegramChatAuthorizationId: `tca_${index + 1}`,
    telegramUserId: String(1001 + index),
    telegramChatId: String(2001 + index),
  }));
  const upsert = jest.fn(
    async ({
      where,
    }: {
      where: {
        orderId_telegramChatAuthorizationId: {
          telegramChatAuthorizationId: string;
        };
      };
    }) => ({
      id: `ton_${where.orderId_telegramChatAuthorizationId.telegramChatAuthorizationId}`,
    })
  );
  const addOrderNotificationJob = jest
    .fn<QueueRuntimeService['addOrderNotificationJob']>()
    .mockResolvedValue({ id: 'job' } as never);
  const scheduler = new OrderNotificationScheduler(
    {
      order: { findFirst: jest.fn(async () => ({ id: 'ord_a' })) },
      telegramOrderNotificationDelivery: { upsert },
    } as unknown as PrismaService,
    {
      eligibleNotificationRecipients: jest.fn(async () => recipients),
    } as unknown as TelegramOrderService,
    { addOrderNotificationJob } as unknown as QueueRuntimeService
  );

  return { scheduler, recipients, upsert, addOrderNotificationJob };
}

describe('M13 order notification scheduling', () => {
  it('creates and enqueues one durable delivery for one eligible recipient', async () => {
    const fixture = setup(1);

    await fixture.scheduler.schedule(event());

    expect(fixture.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orderId_telegramChatAuthorizationId: {
            orderId: 'ord_a',
            telegramChatAuthorizationId: 'tca_1',
          },
        },
        create: expect.objectContaining({
          tenantId: 'ten_a',
          storeId: 'sto_a',
          orderId: 'ord_a',
          telegramAccountId: 'tga_1',
          sourceWebhookEventId: 'evt_a',
        }),
      })
    );
    expect(fixture.addOrderNotificationJob).toHaveBeenCalledWith(
      {
        deliveryId: 'ton_tca_1',
        tenantId: 'ten_a',
        storeId: 'sto_a',
      },
      orderNotificationJobId('ton_tca_1')
    );
  });

  it('fans out independently to every eligible recipient', async () => {
    const fixture = setup(3);

    await fixture.scheduler.schedule(event());

    expect(fixture.upsert).toHaveBeenCalledTimes(3);
    expect(fixture.addOrderNotificationJob).toHaveBeenCalledTimes(3);
  });

  it('creates no delivery when current M11 context yields no recipient', async () => {
    const fixture = setup(0);

    await fixture.scheduler.schedule(event());

    expect(fixture.upsert).not.toHaveBeenCalled();
    expect(fixture.addOrderNotificationJob).not.toHaveBeenCalled();
  });

  it('reuses the same logical delivery and deterministic job on replay', async () => {
    const fixture = setup(1);

    await Promise.all([
      fixture.scheduler.schedule(event()),
      fixture.scheduler.schedule(event()),
    ]);

    const deliveryIds = fixture.addOrderNotificationJob.mock.calls.map(
      (call) => call[0].deliveryId
    );
    const jobIds = fixture.addOrderNotificationJob.mock.calls.map(
      (call) => call[1]
    );

    expect(new Set(deliveryIds)).toEqual(new Set(['ton_tca_1']));
    expect(new Set(jobIds)).toEqual(
      new Set([orderNotificationJobId('ton_tca_1')])
    );
  });

  it('does not schedule other webhook topics', async () => {
    const fixture = setup(1);

    await fixture.scheduler.schedule({ ...event(), topic: 'order.updated' });

    expect(fixture.upsert).not.toHaveBeenCalled();
  });
});
