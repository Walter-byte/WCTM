import {
  Prisma,
  PrismaClient,
  StoreStatus,
  WebhookEventStatus,
} from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';

import { EncryptionService } from '../common/encryption/encryption.service';
import { orderProjectionFingerprint } from '../orders/order-payload.mapper';
import { minimizeWebhookPayload } from '../webhooks/webhook-payload-minimizer';

export interface PilotTarget {
  tenantId: string;
  storeId: string;
  baseUrl: string;
}

export class PilotDataService {
  constructor(
    private readonly database: PrismaClient,
    private readonly encryption: EncryptionService
  ) {}

  async resolve(target: PilotTarget) {
    const stores = await this.database.store.findMany({
      where: {
        id: target.storeId,
        tenantId: target.tenantId,
        baseUrl: target.baseUrl,
      },
      select: {
        id: true,
        tenantId: true,
        baseUrl: true,
        status: true,
        deletedAt: true,
      },
      take: 2,
    });
    if (stores.length !== 1) {
      throw new Error('privacy target identity is missing or ambiguous');
    }
    return stores[0]!;
  }

  async inspect(target: PilotTarget) {
    const store = await this.resolve(target);
    const where = { tenantId: target.tenantId, storeId: target.storeId };
    const [orders, events, inventory, orderDeliveries, inventoryDeliveries] =
      await Promise.all([
        this.database.order.count({ where }),
        this.database.webhookEvent.count({ where }),
        this.database.inventoryItem.count({ where }),
        this.database.telegramOrderNotificationDelivery.count({ where }),
        this.database.telegramInventoryNotificationDelivery.count({ where }),
      ]);
    return {
      tenantId: store.tenantId,
      storeId: store.id,
      status: store.status,
      disconnected: store.deletedAt !== null,
      counts: {
        orders,
        events,
        inventory,
        orderDeliveries,
        inventoryDeliveries,
      },
    };
  }

  async disconnect(target: PilotTarget): Promise<void> {
    await this.resolve(target);
    const now = new Date();
    const revoked = this.encryption.encrypt(randomBytes(32).toString('hex'));

    await this.database.$transaction(async (transaction) => {
      const result = await transaction.store.updateMany({
        where: {
          id: target.storeId,
          tenantId: target.tenantId,
          baseUrl: target.baseUrl,
        },
        data: {
          status: StoreStatus.DISCONNECTED,
          deletedAt: now,
          pluginSecretHash: null,
          pluginRegisteredAt: null,
          registrationTokenHash: null,
          registrationTokenExpiresAt: null,
          webhookSecretEncrypted: null,
          webhookEndpointKey: null,
          consumerKeyEncrypted: revoked,
          consumerSecretEncrypted: revoked,
        },
      });
      if (result.count !== 1) {
        throw new Error('privacy target changed before disconnect');
      }
      await transaction.telegramChatAuthorization.updateMany({
        where: {
          activeStoreId: target.storeId,
          activeTenantId: target.tenantId,
        },
        data: { activeStoreId: null, activeTenantId: null, revokedAt: now },
      });
      await transaction.webhookEvent.updateMany({
        where: {
          tenantId: target.tenantId,
          storeId: target.storeId,
          status: {
            in: [
              WebhookEventStatus.RECEIVED,
              WebhookEventStatus.QUEUED,
              WebhookEventStatus.PROCESSING,
            ],
          },
        },
        data: {
          status: WebhookEventStatus.FAILED,
          processingStartedAt: null,
          failureCategory: 'privacy',
          failureMessage: 'store-disconnected',
          failedAt: now,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `aud_${randomUUID()}`,
          tenantId: target.tenantId,
          userId: null,
          action: 'privacy.store_disconnected',
          entityType: 'Store',
          entityId: target.storeId,
          metadata: { scope: 'operator' },
        },
      });
    });
  }

  async export(target: PilotTarget) {
    await this.resolve(target);
    const where = { tenantId: target.tenantId, storeId: target.storeId };
    const [orders, inventory, events] = await Promise.all([
      this.database.order.findMany({
        where,
        select: {
          wcOrderId: true,
          orderNumber: true,
          status: true,
          currency: true,
          totals: true,
          customerSnapshot: true,
          lineItemsSnapshot: true,
          paymentSnapshot: true,
          shippingLinesSnapshot: true,
          wcCreatedAt: true,
        },
      }),
      this.database.inventoryItem.findMany({
        where,
        select: {
          wcItemId: true,
          displayName: true,
          sku: true,
          stockQuantity: true,
          stockStatus: true,
        },
      }),
      this.database.webhookEvent.findMany({
        where,
        select: { id: true, topic: true, status: true, receivedAt: true },
      }),
    ]);
    return {
      tenantId: target.tenantId,
      storeId: target.storeId,
      exportedAt: new Date().toISOString(),
      orders,
      inventory,
      events,
    };
  }

  async scrubHistorical(target: PilotTarget, execute: boolean) {
    await this.resolve(target);
    const where = { tenantId: target.tenantId, storeId: target.storeId };
    let changedEvents = 0;
    let changedOrders = 0;
    let eventCursor: string | undefined;
    for (;;) {
      const events = await this.database.webhookEvent.findMany({
        where: {
          ...where,
          status: {
            in: [WebhookEventStatus.COMPLETED, WebhookEventStatus.FAILED],
          },
        },
        select: { id: true, topic: true, payload: true, status: true },
        orderBy: { id: 'asc' },
        take: 100,
        ...(eventCursor ? { cursor: { id: eventCursor }, skip: 1 } : {}),
      });
      if (events.length === 0) break;
      eventCursor = events[events.length - 1]!.id;
      for (const event of events) {
        const minimized = minimizeWebhookPayload(event.topic, event.payload);
        if (JSON.stringify(event.payload) === JSON.stringify(minimized))
          continue;
        changedEvents++;
        if (execute) {
          const changed = await this.database.webhookEvent.updateMany({
            where: { id: event.id, ...where, status: event.status },
            data: { payload: minimized },
          });
          if (changed.count !== 1)
            throw new Error('historical event changed during scrub');
        }
      }
    }
    let orderCursor: string | undefined;
    for (;;) {
      const orders = await this.database.order.findMany({
        where,
        orderBy: { id: 'asc' },
        take: 100,
        ...(orderCursor ? { cursor: { id: orderCursor }, skip: 1 } : {}),
      });
      if (orders.length === 0) break;
      orderCursor = orders[orders.length - 1]!.id;
      for (const order of orders) {
        const customer = jsonRecord(order.customerSnapshot);
        const customerSnapshot = {
          billing: pick(jsonRecord(customer['billing']), [
            'first_name',
            'last_name',
            'company',
          ]),
          shipping: pick(jsonRecord(customer['shipping']), [
            'company',
            'address_1',
            'address_2',
            'city',
            'state',
            'postcode',
            'country',
          ]),
        };
        const lineItemsSnapshot = Array.isArray(order.lineItemsSnapshot)
          ? order.lineItemsSnapshot.map((line) =>
              pick(jsonRecord(line), ['name', 'quantity', 'total'])
            )
          : [];
        if (
          JSON.stringify(order.customerSnapshot) ===
            JSON.stringify(customerSnapshot) &&
          JSON.stringify(order.lineItemsSnapshot) ===
            JSON.stringify(lineItemsSnapshot)
        )
          continue;
        changedOrders++;
        if (execute) {
          const fingerprint = orderProjectionFingerprint({
            wcOrderId: order.wcOrderId,
            orderNumber: order.orderNumber,
            status: order.status,
            currency: order.currency,
            totals: order.totals as Prisma.InputJsonObject,
            customerSnapshot,
            lineItemsSnapshot,
            paymentSnapshot: order.paymentSnapshot as Prisma.InputJsonObject,
            shippingLinesSnapshot:
              order.shippingLinesSnapshot as Prisma.InputJsonArray,
            wcCreatedAt: order.wcCreatedAt,
            wcModifiedAt: order.wcModifiedAt,
            remoteDeletedAt: order.remoteDeletedAt,
          });
          const changed = await this.database.order.updateMany({
            where: {
              id: order.id,
              ...where,
              projectionFingerprint: order.projectionFingerprint,
            },
            data: {
              customerSnapshot,
              lineItemsSnapshot,
              projectionFingerprint: fingerprint,
            },
          });
          if (changed.count !== 1)
            throw new Error('historical Order changed during scrub');
        }
      }
    }
    return { changedEvents, changedOrders, executed: execute };
  }

  async erase(target: PilotTarget): Promise<void> {
    const store = await this.resolve(target);
    if (store.status !== StoreStatus.DISCONNECTED || !store.deletedAt) {
      throw new Error('privacy erasure requires verified disconnect first');
    }
    const where = { tenantId: target.tenantId, storeId: target.storeId };
    await this.database.$transaction(async (transaction) => {
      await transaction.webhookEvent.updateMany({
        where,
        data: { payload: {} },
      });
      await transaction.order.updateMany({
        where,
        data: {
          orderNumber: 'erased',
          totals: {},
          customerSnapshot: {},
          lineItemsSnapshot: [],
          paymentSnapshot: {},
          shippingLinesSnapshot: [],
          projectionFingerprint: '0'.repeat(64),
        },
      });
      await transaction.inventoryItem.updateMany({
        where,
        data: {
          displayName: 'Erased product',
          sku: null,
          variationContext: [],
        },
      });
      await transaction.telegramCallbackReference.updateMany({
        where,
        data: { noteBodyEncrypted: null, noteContentFingerprint: null },
      });
      await transaction.telegramSearchReference.updateMany({
        where,
        data: { queryEncrypted: null },
      });
      await transaction.telegramOrderNoteAction.updateMany({
        where,
        data: { contentFingerprint: '0'.repeat(64), result: Prisma.DbNull },
      });
      await transaction.telegramOrderStatusWrite.updateMany({
        where,
        data: { result: Prisma.DbNull },
      });
      const changed = await transaction.store.updateMany({
        where: {
          id: target.storeId,
          tenantId: target.tenantId,
          baseUrl: target.baseUrl,
          status: StoreStatus.DISCONNECTED,
          deletedAt: { not: null },
        },
        data: {
          name: 'Erased store',
          baseUrl: `https://erased.invalid/${target.storeId}`,
        },
      });
      if (changed.count !== 1)
        throw new Error('privacy target changed during erasure');
      await transaction.auditLog.create({
        data: {
          id: `aud_${randomUUID()}`,
          tenantId: target.tenantId,
          userId: null,
          action: 'privacy.store_erased',
          entityType: 'Store',
          entityId: target.storeId,
          metadata: { scope: 'operator', preserved: 'security-audit' },
        },
      });
    });
  }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pick(record: Record<string, unknown>, fields: string[]) {
  const value: Record<string, string | number> = {};
  for (const field of fields) {
    const candidate = record[field];
    if (
      typeof candidate === 'string' ||
      (typeof candidate === 'number' && Number.isFinite(candidate))
    ) {
      value[field] = candidate;
    }
  }
  return value;
}
