import { forwardRef, Inject, Injectable } from '@nestjs/common';
import {
  NotificationCategory,
  NotificationRecipientMode,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { readWooCommerceOrderId } from '../orders/order-payload.mapper';
import { EntitlementService } from '../entitlements/entitlement.service';
import type { ProjectableWebhookEvent } from '../orders/order-projection.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramOrderService } from '../telegram/telegram-order.service';
import { QueueRuntimeService } from './queue-runtime.service';

const ORDER_CREATED_TOPIC = 'order.created';

@Injectable()
export class OrderNotificationScheduler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegramOrders: TelegramOrderService,
    @Inject(forwardRef(() => QueueRuntimeService))
    private readonly queueRuntime: QueueRuntimeService,
    private readonly entitlements: EntitlementService
  ) {}

  async schedule(event: ProjectableWebhookEvent): Promise<void> {
    if (event.topic !== ORDER_CREATED_TOPIC) {
      return;
    }

    if (!(await this.entitlements.isActive(event.store.tenantId))) {
      return;
    }

    const settings = await this.prisma.store.findFirst({
      where: {
        id: event.store.id,
        tenantId: event.store.tenantId,
        deletedAt: null,
      },
      select: {
        enabledNotificationCategories: true,
        notificationRecipientMode: true,
        selectedNotificationRecipients: {
          select: { membershipId: true },
        },
      },
    });

    if (
      !settings ||
      !settings.enabledNotificationCategories.includes(
        NotificationCategory.ORDER_CREATED
      )
    ) {
      return;
    }

    const wcOrderId = readWooCommerceOrderId(event.payload);
    const order = await this.prisma.order.findFirst({
      where: {
        tenantId: event.store.tenantId,
        storeId: event.store.id,
        wcOrderId,
      },
      select: { id: true },
    });

    if (!order) {
      throw new Error('Projected Order is unavailable for notification');
    }

    const eligible = await this.telegramOrders.eligibleNotificationRecipients(
      event.store.tenantId,
      event.store.id
    );
    const selectedMembershipIds = new Set(
      settings.selectedNotificationRecipients.map(
        (recipient) => recipient.membershipId
      )
    );
    const recipients =
      settings.notificationRecipientMode ===
      NotificationRecipientMode.ALL_ELIGIBLE
        ? eligible
        : eligible.filter(
            (recipient) =>
              recipient.membershipId !== undefined &&
              selectedMembershipIds.has(recipient.membershipId)
          );

    for (const recipient of recipients) {
      const delivery =
        await this.prisma.telegramOrderNotificationDelivery.upsert({
          where: {
            orderId_telegramChatAuthorizationId: {
              orderId: order.id,
              telegramChatAuthorizationId:
                recipient.telegramChatAuthorizationId,
            },
          },
          create: {
            id: `ton_${randomUUID()}`,
            tenantId: event.store.tenantId,
            storeId: event.store.id,
            orderId: order.id,
            telegramAccountId: recipient.telegramAccountId,
            telegramChatAuthorizationId: recipient.telegramChatAuthorizationId,
            sourceWebhookEventId: event.id,
          },
          update: {},
          select: { id: true },
        });

      await this.queueRuntime.addOrderNotificationJob(
        {
          deliveryId: delivery.id,
          tenantId: event.store.tenantId,
          storeId: event.store.id,
        },
        orderNotificationJobId(delivery.id)
      );
    }
  }
}

export const orderNotificationJobId = (deliveryId: string): string =>
  `telegram-order-notification-${deliveryId}`;
