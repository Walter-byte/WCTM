import { forwardRef, Inject, Injectable } from '@nestjs/common';
import {
  InventoryAlertLevel,
  NotificationCategory,
  NotificationRecipientMode,
  Prisma,
  TelegramInventoryNotificationState,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import type { InventoryAlertSignal } from '../inventory/inventory-projection.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramOrderService } from '../telegram/telegram-order.service';
import { QueueRuntimeService } from './queue-runtime.service';

@Injectable()
export class InventoryNotificationScheduler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegramOrders: TelegramOrderService,
    @Inject(forwardRef(() => QueueRuntimeService))
    private readonly queueRuntime: QueueRuntimeService,
    private readonly entitlements: EntitlementService
  ) {}

  async schedule(
    tenantId: string,
    storeId: string,
    signal: InventoryAlertSignal
  ): Promise<void> {
    const item = await this.prisma.inventoryItem.findFirst({
      where: {
        id: signal.inventoryItemId,
        tenantId,
        storeId,
        incidentGeneration: signal.incidentGeneration,
      },
      select: {
        id: true,
        lowAlertSourceWebhookEventId: true,
        lowAlertRecipientsCapturedAt: true,
        outAlertSourceWebhookEventId: true,
        outAlertRecipientsCapturedAt: true,
      },
    });

    if (!item || !this.signalMatches(item, signal)) {
      return;
    }

    const capturedAt =
      signal.alertLevel === InventoryAlertLevel.LOW_STOCK
        ? item.lowAlertRecipientsCapturedAt
        : item.outAlertRecipientsCapturedAt;

    if (!(await this.entitlements.isActive(tenantId))) {
      if (!capturedAt) {
        await this.captureRecipients(tenantId, storeId, signal, []);
      }
      return;
    }

    if (!capturedAt) {
      const policy = await this.prisma.store.findFirst({
        where: { id: storeId, tenantId, deletedAt: null },
        select: {
          enabledNotificationCategories: true,
          notificationRecipientMode: true,
          inventoryNotificationPolicyVersion: true,
          selectedNotificationRecipients: {
            select: { membershipId: true },
          },
        },
      });
      const eligible =
        policy?.enabledNotificationCategories.includes(
          NotificationCategory.LOW_STOCK
        ) === true
          ? await this.telegramOrders.eligibleNotificationRecipients(
              tenantId,
              storeId
            )
          : [];
      const selectedMembershipIds = new Set(
        policy?.selectedNotificationRecipients.map(
          (recipient) => recipient.membershipId
        ) ?? []
      );
      const recipients =
        policy?.notificationRecipientMode ===
        NotificationRecipientMode.ALL_ELIGIBLE
          ? eligible
          : eligible.filter(
              (recipient) =>
                recipient.membershipId !== undefined &&
                selectedMembershipIds.has(recipient.membershipId)
            );

      await this.captureRecipients(
        tenantId,
        storeId,
        signal,
        recipients.map((recipient) => ({
          id: `tin_${randomUUID()}`,
          tenantId,
          storeId,
          inventoryItemId: signal.inventoryItemId,
          incidentGeneration: signal.incidentGeneration,
          alertLevel: signal.alertLevel,
          policyVersion: policy!.inventoryNotificationPolicyVersion,
          telegramAccountId: recipient.telegramAccountId,
          telegramChatAuthorizationId: recipient.telegramChatAuthorizationId,
          sourceWebhookEventId: signal.sourceWebhookEventId,
        }))
      );
    }

    const deliveries =
      await this.prisma.telegramInventoryNotificationDelivery.findMany({
        where: {
          tenantId,
          storeId,
          inventoryItemId: signal.inventoryItemId,
          incidentGeneration: signal.incidentGeneration,
          alertLevel: signal.alertLevel,
          sourceWebhookEventId: signal.sourceWebhookEventId,
          state: {
            in: [
              TelegramInventoryNotificationState.PENDING,
              TelegramInventoryNotificationState.RETRYABLE_FAILURE,
            ],
          },
        },
        select: { id: true },
      });

    for (const delivery of deliveries) {
      await this.queueRuntime.addInventoryNotificationJob(
        { deliveryId: delivery.id, tenantId, storeId },
        inventoryNotificationJobId(delivery.id)
      );
    }
  }

  private async captureRecipients(
    tenantId: string,
    storeId: string,
    signal: InventoryAlertSignal,
    deliveries: Prisma.TelegramInventoryNotificationDeliveryCreateManyInput[]
  ): Promise<void> {
    await this.prisma.$transaction(
      async (transaction) => {
        const captured = await transaction.inventoryItem.updateMany({
          where: {
            id: signal.inventoryItemId,
            tenantId,
            storeId,
            incidentGeneration: signal.incidentGeneration,
            ...(signal.alertLevel === InventoryAlertLevel.LOW_STOCK
              ? {
                  lowAlertSourceWebhookEventId: signal.sourceWebhookEventId,
                  lowAlertRecipientsCapturedAt: null,
                }
              : {
                  outAlertSourceWebhookEventId: signal.sourceWebhookEventId,
                  outAlertRecipientsCapturedAt: null,
                }),
          },
          data:
            signal.alertLevel === InventoryAlertLevel.LOW_STOCK
              ? { lowAlertRecipientsCapturedAt: new Date() }
              : { outAlertRecipientsCapturedAt: new Date() },
        });

        if (captured.count !== 1) {
          return;
        }

        if (deliveries.length > 0) {
          await transaction.telegramInventoryNotificationDelivery.createMany({
            data: deliveries,
            skipDuplicates: true,
          });
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  private signalMatches(
    item: {
      lowAlertSourceWebhookEventId: string | null;
      outAlertSourceWebhookEventId: string | null;
    },
    signal: InventoryAlertSignal
  ): boolean {
    return signal.alertLevel === InventoryAlertLevel.LOW_STOCK
      ? item.lowAlertSourceWebhookEventId === signal.sourceWebhookEventId
      : item.outAlertSourceWebhookEventId === signal.sourceWebhookEventId;
  }
}

export const inventoryNotificationJobId = (deliveryId: string): string =>
  `telegram-inventory-notification-${deliveryId}`;
