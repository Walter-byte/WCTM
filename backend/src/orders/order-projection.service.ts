import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { EncryptionService } from '../common/encryption/encryption.service';
import { ApplicationConfigService } from '../config/application-config.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  type WooCommerceErrorCategory,
  WooCommerceClient,
  WooCommerceClientError,
} from '../woocommerce/client/woocommerce.client';
import {
  mapWooCommerceOrder,
  type OrderProjection,
  OrderPayloadMappingError,
  orderProjectionFingerprint,
  readWooCommerceOrderId,
  withRemoteDeletedAt,
} from './order-payload.mapper';

const ORDER_CREATED_TOPIC = 'order.created';
const ORDER_UPDATED_TOPIC = 'order.updated';
const ORDER_DELETED_TOPIC = 'order.deleted';
const ORDER_RESTORED_TOPIC = 'order.restored';
const ORDER_TOPICS = new Set([
  ORDER_CREATED_TOPIC,
  ORDER_UPDATED_TOPIC,
  ORDER_DELETED_TOPIC,
  ORDER_RESTORED_TOPIC,
]);
const PROJECTION_TRANSACTION_ATTEMPTS = 3;
const RETRYABLE_WOOCOMMERCE_CATEGORIES = new Set<WooCommerceErrorCategory>([
  'transport',
  'rate-limited',
  'timeout',
]);

type RemoteDeletionMode = 'clear' | 'preserve';
type ProjectionDecision = 'apply' | 'noop' | 'reconcile';

export interface ProjectableStore {
  id: string;
  tenantId: string;
  baseUrl: string;
  consumerKeyEncrypted: string;
  consumerSecretEncrypted: string;
}

export interface ProjectableWebhookEvent {
  id: string;
  topic: string;
  payload: Prisma.JsonValue;
  receivedAt: Date;
  store: ProjectableStore;
}

interface ExistingOrderProjection {
  id: string;
  tenantId: string;
  storeId: string;
  wcOrderId: string;
  orderNumber: string;
  status: string;
  currency: string;
  totals: Prisma.JsonValue;
  customerSnapshot: Prisma.JsonValue;
  lineItemsSnapshot: Prisma.JsonValue;
  wcCreatedAt: Date;
  wcModifiedAt: Date;
  projectionFingerprint: string;
  remoteDeletedAt: Date | null;
  lastSyncedAt: Date;
}

export class OrderProjectionFailure extends Error {
  constructor(
    readonly category: WooCommerceErrorCategory,
    readonly code: string,
    readonly retryable: boolean
  ) {
    super(code);
    this.name = 'OrderProjectionFailure';
  }
}

export function decideOrderProjection(
  storedModifiedAt: Date,
  storedFingerprint: string,
  incomingModifiedAt: Date,
  incomingFingerprint: string,
  authoritative: boolean
): ProjectionDecision {
  const timestampComparison =
    incomingModifiedAt.getTime() - storedModifiedAt.getTime();

  if (timestampComparison < 0) {
    return 'noop';
  }

  if (timestampComparison > 0) {
    return 'apply';
  }

  if (storedFingerprint === incomingFingerprint) {
    return 'noop';
  }

  return authoritative ? 'apply' : 'reconcile';
}

@Injectable()
export class OrderProjectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly configuration: ApplicationConfigService
  ) {}

  async project(event: ProjectableWebhookEvent): Promise<void> {
    if (!ORDER_TOPICS.has(event.topic)) {
      return;
    }

    if (event.topic === ORDER_DELETED_TOPIC) {
      await this.projectDeletion(event);
      return;
    }

    let mapped: OrderProjection;

    try {
      mapped = mapWooCommerceOrder(event.payload);
    } catch (error: unknown) {
      await this.reconcileMappingFailure(event, error);
      return;
    }

    const mode: RemoteDeletionMode =
      event.topic === ORDER_RESTORED_TOPIC ? 'clear' : 'preserve';
    const outcome = await this.applyProjection(
      event.store,
      mapped,
      false,
      mode
    );

    if (outcome === 'reconcile') {
      await this.reconcile(event.store, mapped.wcOrderId);
    }
  }

  async reconcileAuthoritativeOrder(
    store: ProjectableStore,
    payload: unknown,
    expectedWcOrderId: string
  ): Promise<void> {
    let authoritative: OrderProjection;

    try {
      authoritative = mapWooCommerceOrder(payload);
    } catch {
      throw new OrderProjectionFailure(
        'unexpected',
        'malformed-reconciliation-payload',
        false
      );
    }

    if (authoritative.wcOrderId !== expectedWcOrderId) {
      throw new OrderProjectionFailure(
        'unexpected',
        'reconciliation-order-identity-mismatch',
        false
      );
    }

    await this.applyProjection(store, authoritative, true, 'clear');
  }

  private async reconcileMappingFailure(
    event: ProjectableWebhookEvent,
    error: unknown
  ): Promise<void> {
    if (!(error instanceof OrderPayloadMappingError) || !error.wcOrderId) {
      throw new OrderProjectionFailure(
        'unexpected',
        error instanceof OrderPayloadMappingError
          ? error.code
          : 'malformed-order-payload',
        false
      );
    }

    await this.reconcile(event.store, error.wcOrderId);
  }

  private async reconcile(
    store: ProjectableStore,
    wcOrderId: string
  ): Promise<void> {
    let payload: unknown;

    try {
      payload = await this.createClient(store).fetchOrder(wcOrderId);
    } catch (error: unknown) {
      if (error instanceof WooCommerceClientError) {
        throw new OrderProjectionFailure(
          error.category,
          `woocommerce-${error.category}`,
          RETRYABLE_WOOCOMMERCE_CATEGORIES.has(error.category)
        );
      }

      throw new OrderProjectionFailure(
        'unexpected',
        'woocommerce-unexpected',
        false
      );
    }

    await this.reconcileAuthoritativeOrder(store, payload, wcOrderId);
  }

  private projectDeletion(event: ProjectableWebhookEvent): Promise<void> {
    let wcOrderId: string;

    try {
      wcOrderId = readWooCommerceOrderId(event.payload);
    } catch (error: unknown) {
      throw new OrderProjectionFailure(
        'unexpected',
        error instanceof OrderPayloadMappingError
          ? error.code
          : 'malformed-order-payload',
        false
      );
    }

    return this.withProjectionTransaction(async (transaction) => {
      const existing = await this.findOrder(
        transaction,
        event.store,
        wcOrderId
      );

      if (
        !existing ||
        (existing.remoteDeletedAt &&
          event.receivedAt <= existing.remoteDeletedAt)
      ) {
        return;
      }

      const projectionFingerprint = orderProjectionFingerprint({
        wcOrderId: existing.wcOrderId,
        orderNumber: existing.orderNumber,
        status: existing.status,
        currency: existing.currency,
        totals: existing.totals as Prisma.InputJsonObject,
        customerSnapshot: existing.customerSnapshot as Prisma.InputJsonObject,
        lineItemsSnapshot: existing.lineItemsSnapshot as Prisma.InputJsonArray,
        wcCreatedAt: existing.wcCreatedAt,
        wcModifiedAt: existing.wcModifiedAt,
        remoteDeletedAt: event.receivedAt,
      });
      const updated = await transaction.order.updateMany({
        where: this.optimisticOrderWhere(existing),
        data: {
          remoteDeletedAt: event.receivedAt,
          projectionFingerprint,
          lastSyncedAt: new Date(),
        },
      });

      if (updated.count !== 1) {
        throw new ConcurrentOrderProjectionError();
      }
    });
  }

  private async applyProjection(
    store: ProjectableStore,
    candidate: OrderProjection,
    authoritative: boolean,
    deletionMode: RemoteDeletionMode
  ): Promise<ProjectionDecision> {
    return this.withProjectionTransaction(async (transaction) => {
      const existing = await this.findOrder(
        transaction,
        store,
        candidate.wcOrderId
      );

      if (!existing) {
        await transaction.order.create({
          data: {
            id: `ord_${randomUUID()}`,
            tenantId: store.tenantId,
            storeId: store.id,
            wcOrderId: candidate.wcOrderId,
            orderNumber: candidate.orderNumber,
            status: candidate.status,
            currency: candidate.currency,
            totals: candidate.totals,
            customerSnapshot: candidate.customerSnapshot,
            lineItemsSnapshot: candidate.lineItemsSnapshot,
            wcCreatedAt: candidate.wcCreatedAt,
            wcModifiedAt: candidate.wcModifiedAt,
            projectionFingerprint: candidate.projectionFingerprint,
            remoteDeletedAt: candidate.remoteDeletedAt,
            lastSyncedAt: new Date(),
          },
          select: { id: true },
        });
        return 'apply';
      }

      const projection =
        deletionMode === 'preserve'
          ? withRemoteDeletedAt(candidate, existing.remoteDeletedAt)
          : candidate;
      const decision = decideOrderProjection(
        existing.wcModifiedAt,
        existing.projectionFingerprint,
        projection.wcModifiedAt,
        projection.projectionFingerprint,
        authoritative
      );

      if (decision !== 'apply') {
        return decision;
      }

      const updated = await transaction.order.updateMany({
        where: this.optimisticOrderWhere(existing),
        data: {
          orderNumber: projection.orderNumber,
          status: projection.status,
          currency: projection.currency,
          totals: projection.totals,
          customerSnapshot: projection.customerSnapshot,
          lineItemsSnapshot: projection.lineItemsSnapshot,
          wcCreatedAt: projection.wcCreatedAt,
          wcModifiedAt: projection.wcModifiedAt,
          projectionFingerprint: projection.projectionFingerprint,
          remoteDeletedAt: projection.remoteDeletedAt,
          lastSyncedAt: new Date(),
        },
      });

      if (updated.count !== 1) {
        throw new ConcurrentOrderProjectionError();
      }

      return 'apply';
    });
  }

  private findOrder(
    transaction: Prisma.TransactionClient,
    store: ProjectableStore,
    wcOrderId: string
  ): Promise<ExistingOrderProjection | null> {
    return transaction.order.findFirst({
      where: {
        tenantId: store.tenantId,
        storeId: store.id,
        wcOrderId,
      },
      select: {
        id: true,
        tenantId: true,
        storeId: true,
        wcOrderId: true,
        orderNumber: true,
        status: true,
        currency: true,
        totals: true,
        customerSnapshot: true,
        lineItemsSnapshot: true,
        wcCreatedAt: true,
        wcModifiedAt: true,
        projectionFingerprint: true,
        remoteDeletedAt: true,
        lastSyncedAt: true,
      },
    });
  }

  private optimisticOrderWhere(existing: ExistingOrderProjection) {
    return {
      id: existing.id,
      tenantId: existing.tenantId,
      storeId: existing.storeId,
      wcModifiedAt: existing.wcModifiedAt,
      projectionFingerprint: existing.projectionFingerprint,
      remoteDeletedAt: existing.remoteDeletedAt,
    };
  }

  private createClient(store: ProjectableStore): WooCommerceClient {
    return new WooCommerceClient({
      storeUrl: store.baseUrl,
      consumerKey: this.encryption.decrypt(store.consumerKeyEncrypted),
      consumerSecret: this.encryption.decrypt(store.consumerSecretEncrypted),
      resilience: this.configuration.woocommerce.rest,
    });
  }

  private async withProjectionTransaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    for (
      let attempt = 1;
      attempt <= PROJECTION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error: unknown) {
        if (
          attempt === PROJECTION_TRANSACTION_ATTEMPTS ||
          !isConcurrentProjectionError(error)
        ) {
          throw error;
        }
      }
    }

    throw new ConcurrentOrderProjectionError();
  }
}

class ConcurrentOrderProjectionError extends Error {
  constructor() {
    super('Concurrent order projection must be retried');
    this.name = 'ConcurrentOrderProjectionError';
  }
}

function isConcurrentProjectionError(error: unknown): boolean {
  return (
    error instanceof ConcurrentOrderProjectionError ||
    (error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'P2002' || error.code === 'P2034'))
  );
}
