import { Injectable } from '@nestjs/common';
import {
  InventoryAlertClassification,
  InventoryAlertLevel,
  Prisma,
} from '@prisma/client';
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
  classifyInventoryItem,
  type InventoryProjection,
  InventoryPayloadMappingError,
  mapWooCommerceInventoryItem,
  readWooCommerceInventoryItemId,
  readWooCommerceInventoryModifiedAt,
  readWooCommerceParentProductId,
} from './inventory-payload.mapper';

const PRODUCT_CREATED_TOPIC = 'product.created';
const PRODUCT_UPDATED_TOPIC = 'product.updated';
const PRODUCT_DELETED_TOPIC = 'product.deleted';
const PRODUCT_RESTORED_TOPIC = 'product.restored';
const PRODUCT_TOPICS = new Set([
  PRODUCT_CREATED_TOPIC,
  PRODUCT_UPDATED_TOPIC,
  PRODUCT_DELETED_TOPIC,
  PRODUCT_RESTORED_TOPIC,
]);
const PROJECTION_TRANSACTION_ATTEMPTS = 3;
const RETRYABLE_WOOCOMMERCE_CATEGORIES = new Set<WooCommerceErrorCategory>([
  'transport',
  'rate-limited',
  'timeout',
]);

export interface InventoryProjectableStore {
  id: string;
  tenantId: string;
  baseUrl: string;
  consumerKeyEncrypted: string;
  consumerSecretEncrypted: string;
}

export interface InventoryProjectableWebhookEvent {
  id: string;
  topic: string;
  payload: Prisma.JsonValue;
  receivedAt: Date;
  store: InventoryProjectableStore;
}

export interface InventoryAlertSignal {
  inventoryItemId: string;
  incidentGeneration: number;
  alertLevel: InventoryAlertLevel;
  sourceWebhookEventId: string;
}

type ProjectionDecision = 'apply' | 'noop' | 'reconcile';

interface ExistingInventoryItem {
  id: string;
  tenantId: string;
  storeId: string;
  wcItemId: string;
  parentWcProductId: string | null;
  wcModifiedAt: Date;
  projectionFingerprint: string;
  remoteDeletedAt: Date | null;
  lastWebhookReceivedAt: Date | null;
  alertClassification: InventoryAlertClassification;
  incidentGeneration: number;
  lowAlertSourceWebhookEventId: string | null;
  outAlertSourceWebhookEventId: string | null;
}

interface ProjectionSource {
  baseline: boolean;
  sourceWebhookEventId?: string;
  webhookReceivedAt?: Date;
  clearDeletion: boolean;
}

export class InventoryProjectionFailure extends Error {
  constructor(
    readonly category: WooCommerceErrorCategory,
    readonly code: string,
    readonly retryable: boolean
  ) {
    super(code);
    this.name = 'InventoryProjectionFailure';
  }
}

export function decideInventoryProjection(
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
export class InventoryProjectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly configuration: ApplicationConfigService
  ) {}

  async projectWebhook(
    event: InventoryProjectableWebhookEvent
  ): Promise<InventoryAlertSignal[]> {
    if (!PRODUCT_TOPICS.has(event.topic)) {
      return [];
    }

    if (event.topic === PRODUCT_DELETED_TOPIC) {
      await this.projectDeletion(event);
      return [];
    }

    let mapped: InventoryProjection;

    try {
      mapped = mapWooCommerceInventoryItem(event.payload);
    } catch (error: unknown) {
      return this.reconcileMappingFailure(event, error);
    }

    const source: ProjectionSource = {
      baseline: false,
      sourceWebhookEventId: event.id,
      webhookReceivedAt: event.receivedAt,
      clearDeletion:
        event.topic === PRODUCT_CREATED_TOPIC ||
        event.topic === PRODUCT_RESTORED_TOPIC,
    };
    const outcome = await this.applyProjection(
      event.store,
      mapped,
      false,
      source
    );

    if (outcome.decision === 'reconcile') {
      return this.reconcile(
        event.store,
        mapped.wcItemId,
        mapped.parentWcProductId ?? undefined,
        source
      );
    }

    const signals = outcome.signal ? [outcome.signal] : [];

    if (!mapped.active && mapped.parentWcProductId) {
      signals.push(
        ...(await this.reconcile(
          event.store,
          mapped.parentWcProductId,
          undefined,
          source
        ))
      );
    }

    return signals;
  }

  async projectBootstrapPayload(
    store: InventoryProjectableStore,
    payload: unknown
  ): Promise<void> {
    let mapped: InventoryProjection;

    try {
      mapped = mapWooCommerceInventoryItem(payload);
    } catch (error: unknown) {
      throw new InventoryProjectionFailure(
        'unexpected',
        error instanceof InventoryPayloadMappingError
          ? error.code
          : 'malformed-inventory-payload',
        false
      );
    }

    await this.applyProjection(store, mapped, true, {
      baseline: true,
      clearDeletion: true,
    });
  }

  private async reconcileMappingFailure(
    event: InventoryProjectableWebhookEvent,
    error: unknown
  ): Promise<InventoryAlertSignal[]> {
    if (!(error instanceof InventoryPayloadMappingError) || !error.wcItemId) {
      throw new InventoryProjectionFailure(
        'unexpected',
        error instanceof InventoryPayloadMappingError
          ? error.code
          : 'malformed-inventory-payload',
        false
      );
    }

    return this.reconcile(
      event.store,
      error.wcItemId,
      error.parentWcProductId,
      {
        baseline: false,
        sourceWebhookEventId: event.id,
        webhookReceivedAt: event.receivedAt,
        clearDeletion: event.topic === PRODUCT_RESTORED_TOPIC,
      }
    );
  }

  private async reconcile(
    store: InventoryProjectableStore,
    wcItemId: string,
    suppliedParentWcProductId: string | undefined,
    source: ProjectionSource
  ): Promise<InventoryAlertSignal[]> {
    const existing = await this.prisma.inventoryItem.findFirst({
      where: { tenantId: store.tenantId, storeId: store.id, wcItemId },
      select: { parentWcProductId: true },
    });
    const parentWcProductId =
      suppliedParentWcProductId ?? existing?.parentWcProductId ?? undefined;
    let payload: unknown;

    try {
      const client = this.createClient(store);
      payload = parentWcProductId
        ? await client.fetchProductVariation(parentWcProductId, wcItemId)
        : await client.fetchProduct(wcItemId);
    } catch (error: unknown) {
      if (error instanceof WooCommerceClientError) {
        throw new InventoryProjectionFailure(
          error.category,
          `woocommerce-${error.category}`,
          RETRYABLE_WOOCOMMERCE_CATEGORIES.has(error.category)
        );
      }

      throw new InventoryProjectionFailure(
        'unexpected',
        'woocommerce-unexpected',
        false
      );
    }

    let mapped: InventoryProjection;

    try {
      mapped = mapWooCommerceInventoryItem(payload);
    } catch {
      throw new InventoryProjectionFailure(
        'unexpected',
        'malformed-inventory-reconciliation-payload',
        false
      );
    }

    if (
      mapped.wcItemId !== wcItemId ||
      (parentWcProductId !== undefined &&
        mapped.parentWcProductId !== parentWcProductId)
    ) {
      throw new InventoryProjectionFailure(
        'unexpected',
        'inventory-reconciliation-identity-mismatch',
        false
      );
    }

    const outcome = await this.applyProjection(store, mapped, true, source);
    return outcome.signal ? [outcome.signal] : [];
  }

  private async projectDeletion(
    event: InventoryProjectableWebhookEvent
  ): Promise<void> {
    let wcItemId: string;

    try {
      wcItemId = readWooCommerceInventoryItemId(event.payload);
    } catch (error: unknown) {
      throw new InventoryProjectionFailure(
        'unexpected',
        error instanceof InventoryPayloadMappingError
          ? error.code
          : 'malformed-inventory-payload',
        false
      );
    }

    const existing = await this.prisma.inventoryItem.findMany({
      where: {
        tenantId: event.store.tenantId,
        storeId: event.store.id,
        OR: [{ wcItemId }, { parentWcProductId: wcItemId }],
      },
      select: {
        wcModifiedAt: true,
        parentWcProductId: true,
      },
    });

    if (existing.length === 0) {
      return;
    }

    let deletedModifiedAt: Date | undefined;

    try {
      deletedModifiedAt = readWooCommerceInventoryModifiedAt(event.payload);
    } catch {
      // An ID-only or malformed delete is reconciled with exactly one live
      // WooCommerce item read below.
    }

    const needsAuthoritativeRead =
      !deletedModifiedAt ||
      existing.some(
        (item) => item.wcModifiedAt.getTime() === deletedModifiedAt!.getTime()
      );

    if (needsAuthoritativeRead) {
      const suppliedParent = (() => {
        try {
          return readWooCommerceParentProductId(event.payload);
        } catch {
          return undefined;
        }
      })();
      const parentWcProductId =
        suppliedParent ??
        existing.find((item) => item.parentWcProductId !== null)
          ?.parentWcProductId ??
        undefined;

      try {
        const client = this.createClient(event.store);
        const current = parentWcProductId
          ? await client.fetchProductVariation(parentWcProductId, wcItemId)
          : await client.fetchProduct(wcItemId);

        // The item currently exists, so this delete is stale or malformed.
        // Rebaseline the authoritative current item without emitting an alert.
        await this.projectBootstrapPayload(event.store, current);
        return;
      } catch (error: unknown) {
        if (
          !(error instanceof WooCommerceClientError) ||
          error.category !== 'not-found'
        ) {
          if (error instanceof InventoryProjectionFailure) {
            throw error;
          }

          if (error instanceof WooCommerceClientError) {
            throw new InventoryProjectionFailure(
              error.category,
              `woocommerce-${error.category}`,
              RETRYABLE_WOOCOMMERCE_CATEGORIES.has(error.category)
            );
          }

          throw new InventoryProjectionFailure(
            'unexpected',
            'woocommerce-unexpected',
            false
          );
        }
      }
    }

    await this.prisma.inventoryItem.updateMany({
      where: {
        tenantId: event.store.tenantId,
        storeId: event.store.id,
        AND: [
          { OR: [{ wcItemId }, { parentWcProductId: wcItemId }] },
          ...(deletedModifiedAt
            ? [{ wcModifiedAt: { lte: deletedModifiedAt } }]
            : []),
          {
            OR: [
              { lastWebhookReceivedAt: null },
              { lastWebhookReceivedAt: { lte: event.receivedAt } },
            ],
          },
        ],
      },
      data: {
        remoteDeletedAt: event.receivedAt,
        lastWebhookReceivedAt: event.receivedAt,
        lastSyncedAt: new Date(),
        alertClassification: InventoryAlertClassification.HEALTHY,
        lowAlertSourceWebhookEventId: null,
        lowAlertRecipientsCapturedAt: null,
        outAlertSourceWebhookEventId: null,
        outAlertRecipientsCapturedAt: null,
      },
    });
  }

  private async applyProjection(
    store: InventoryProjectableStore,
    candidate: InventoryProjection,
    authoritative: boolean,
    source: ProjectionSource
  ): Promise<{
    decision: ProjectionDecision;
    signal?: InventoryAlertSignal;
  }> {
    return this.withProjectionTransaction(async (transaction) => {
      const settings = await transaction.store.findFirst({
        where: {
          id: store.id,
          tenantId: store.tenantId,
          deletedAt: null,
          tenant: { deletedAt: null },
        },
        select: { lowStockThreshold: true },
      });

      if (!settings) {
        throw new InventoryProjectionFailure(
          'not-found',
          'inventory-store-unavailable',
          false
        );
      }

      const existing = await this.findItem(
        transaction,
        store,
        candidate.wcItemId
      );
      const classification = candidate.active
        ? classifyInventoryItem(
            candidate.managesStock,
            candidate.stockQuantity,
            candidate.stockStatus,
            settings.lowStockThreshold
          )
        : InventoryAlertClassification.HEALTHY;

      if (!existing) {
        if (!candidate.active) {
          return { decision: 'apply' as const };
        }

        const incidentGeneration =
          classification === InventoryAlertClassification.HEALTHY ? 0 : 1;
        const alertLevel = this.entryAlertLevel(classification);
        const signal =
          !source.baseline && alertLevel && source.sourceWebhookEventId
            ? {
                inventoryItemId: `inv_${randomUUID()}`,
                incidentGeneration,
                alertLevel,
                sourceWebhookEventId: source.sourceWebhookEventId,
              }
            : undefined;
        const id = signal?.inventoryItemId ?? `inv_${randomUUID()}`;

        await transaction.inventoryItem.create({
          data: {
            id,
            tenantId: store.tenantId,
            storeId: store.id,
            wcItemId: candidate.wcItemId,
            parentWcProductId: candidate.parentWcProductId,
            kind: candidate.kind,
            displayName: candidate.displayName,
            sku: candidate.sku,
            variationContext: candidate.variationContext,
            managesStock: candidate.managesStock,
            stockQuantity: candidate.stockQuantity,
            stockStatus: candidate.stockStatus,
            wcModifiedAt: candidate.wcModifiedAt,
            projectionFingerprint: candidate.projectionFingerprint,
            lastSyncedAt: new Date(),
            lastWebhookReceivedAt: source.webhookReceivedAt,
            remoteDeletedAt: null,
            alertClassification: classification,
            incidentGeneration,
            ...(signal?.alertLevel === InventoryAlertLevel.LOW_STOCK
              ? { lowAlertSourceWebhookEventId: source.sourceWebhookEventId }
              : {}),
            ...(signal?.alertLevel === InventoryAlertLevel.OUT_OF_STOCK
              ? { outAlertSourceWebhookEventId: source.sourceWebhookEventId }
              : {}),
          },
          select: { id: true },
        });

        return { decision: 'apply' as const, ...(signal ? { signal } : {}) };
      }

      // A page fetched before a product webhook must never win an equal-time
      // race merely because the bootstrap response is treated as authoritative.
      if (
        source.baseline &&
        existing.lastWebhookReceivedAt !== null &&
        candidate.wcModifiedAt.getTime() <= existing.wcModifiedAt.getTime()
      ) {
        return { decision: 'noop' as const };
      }

      let decision = decideInventoryProjection(
        existing.wcModifiedAt,
        existing.projectionFingerprint,
        candidate.wcModifiedAt,
        candidate.projectionFingerprint,
        authoritative
      );

      // Restore/created carries remote lifecycle meaning that is intentionally
      // not part of the narrow stock fingerprint. Verify an otherwise-equal
      // reactivation once against WooCommerce before clearing deletion.
      if (
        existing.remoteDeletedAt !== null &&
        source.clearDeletion &&
        decision === 'noop'
      ) {
        decision = authoritative ? 'apply' : 'reconcile';
      }

      if (decision !== 'apply') {
        return {
          decision,
          ...(!source.baseline
            ? { signal: this.replaySignal(existing, source) }
            : {}),
        };
      }

      const preservedDeletion = source.clearDeletion
        ? null
        : existing.remoteDeletedAt;
      const remainsDeleted = preservedDeletion !== null;
      const effectiveClassification = remainsDeleted
        ? InventoryAlertClassification.HEALTHY
        : classification;
      const incident = this.nextIncident(
        existing,
        effectiveClassification,
        source
      );
      const updated = await transaction.inventoryItem.updateMany({
        where: this.optimisticItemWhere(existing),
        data: {
          parentWcProductId: candidate.parentWcProductId,
          kind: candidate.kind,
          displayName: candidate.displayName,
          sku: candidate.sku,
          variationContext: candidate.variationContext,
          managesStock: candidate.managesStock,
          stockQuantity: candidate.stockQuantity,
          stockStatus: candidate.stockStatus,
          wcModifiedAt: candidate.wcModifiedAt,
          projectionFingerprint: candidate.projectionFingerprint,
          lastSyncedAt: new Date(),
          ...(source.webhookReceivedAt
            ? { lastWebhookReceivedAt: source.webhookReceivedAt }
            : {}),
          remoteDeletedAt: candidate.active
            ? preservedDeletion
            : (source.webhookReceivedAt ?? new Date()),
          alertClassification: effectiveClassification,
          ...incident.data,
        },
      });

      if (updated.count !== 1) {
        throw new ConcurrentInventoryProjectionError();
      }

      return {
        decision: 'apply' as const,
        ...(incident.signal ? { signal: incident.signal } : {}),
      };
    });
  }

  private nextIncident(
    existing: ExistingInventoryItem,
    classification: InventoryAlertClassification,
    source: ProjectionSource
  ): {
    data: Prisma.InventoryItemUpdateManyMutationInput;
    signal?: InventoryAlertSignal;
  } {
    if (classification === InventoryAlertClassification.HEALTHY) {
      return {
        data: {
          lowAlertSourceWebhookEventId: null,
          lowAlertRecipientsCapturedAt: null,
          outAlertSourceWebhookEventId: null,
          outAlertRecipientsCapturedAt: null,
        },
      };
    }

    if (existing.alertClassification === classification) {
      return {
        data: {},
        ...(!source.baseline
          ? { signal: this.replaySignal(existing, source) }
          : {}),
      };
    }

    if (
      existing.alertClassification ===
        InventoryAlertClassification.OUT_OF_STOCK &&
      classification === InventoryAlertClassification.LOW_STOCK
    ) {
      return { data: {} };
    }

    const startsIncident =
      existing.alertClassification === InventoryAlertClassification.HEALTHY;
    const generation = startsIncident
      ? existing.incidentGeneration + 1
      : existing.incidentGeneration;
    const level = this.entryAlertLevel(classification);
    const canSignal =
      !source.baseline &&
      Boolean(source.sourceWebhookEventId) &&
      Boolean(level);
    const signal = canSignal
      ? {
          inventoryItemId: existing.id,
          incidentGeneration: generation,
          alertLevel: level!,
          sourceWebhookEventId: source.sourceWebhookEventId!,
        }
      : undefined;

    return {
      data: {
        incidentGeneration: generation,
        ...(startsIncident
          ? {
              lowAlertSourceWebhookEventId: null,
              lowAlertRecipientsCapturedAt: null,
              outAlertSourceWebhookEventId: null,
              outAlertRecipientsCapturedAt: null,
            }
          : {}),
        ...(classification === InventoryAlertClassification.LOW_STOCK
          ? {
              lowAlertSourceWebhookEventId:
                signal?.sourceWebhookEventId ?? null,
              lowAlertRecipientsCapturedAt: null,
            }
          : {
              outAlertSourceWebhookEventId:
                signal?.sourceWebhookEventId ?? null,
              outAlertRecipientsCapturedAt: null,
            }),
      },
      ...(signal ? { signal } : {}),
    };
  }

  private replaySignal(
    existing: ExistingInventoryItem,
    source: ProjectionSource
  ): InventoryAlertSignal | undefined {
    if (!source.sourceWebhookEventId) {
      return undefined;
    }

    if (existing.lowAlertSourceWebhookEventId === source.sourceWebhookEventId) {
      return {
        inventoryItemId: existing.id,
        incidentGeneration: existing.incidentGeneration,
        alertLevel: InventoryAlertLevel.LOW_STOCK,
        sourceWebhookEventId: source.sourceWebhookEventId,
      };
    }

    if (existing.outAlertSourceWebhookEventId === source.sourceWebhookEventId) {
      return {
        inventoryItemId: existing.id,
        incidentGeneration: existing.incidentGeneration,
        alertLevel: InventoryAlertLevel.OUT_OF_STOCK,
        sourceWebhookEventId: source.sourceWebhookEventId,
      };
    }

    return undefined;
  }

  private entryAlertLevel(
    classification: InventoryAlertClassification
  ): InventoryAlertLevel | undefined {
    if (classification === InventoryAlertClassification.LOW_STOCK) {
      return InventoryAlertLevel.LOW_STOCK;
    }

    if (classification === InventoryAlertClassification.OUT_OF_STOCK) {
      return InventoryAlertLevel.OUT_OF_STOCK;
    }

    return undefined;
  }

  private findItem(
    transaction: Prisma.TransactionClient,
    store: InventoryProjectableStore,
    wcItemId: string
  ): Promise<ExistingInventoryItem | null> {
    return transaction.inventoryItem.findFirst({
      where: { tenantId: store.tenantId, storeId: store.id, wcItemId },
      select: {
        id: true,
        tenantId: true,
        storeId: true,
        wcItemId: true,
        parentWcProductId: true,
        wcModifiedAt: true,
        projectionFingerprint: true,
        remoteDeletedAt: true,
        lastWebhookReceivedAt: true,
        alertClassification: true,
        incidentGeneration: true,
        lowAlertSourceWebhookEventId: true,
        outAlertSourceWebhookEventId: true,
      },
    });
  }

  private optimisticItemWhere(existing: ExistingInventoryItem) {
    return {
      id: existing.id,
      tenantId: existing.tenantId,
      storeId: existing.storeId,
      wcModifiedAt: existing.wcModifiedAt,
      projectionFingerprint: existing.projectionFingerprint,
      remoteDeletedAt: existing.remoteDeletedAt,
      alertClassification: existing.alertClassification,
      incidentGeneration: existing.incidentGeneration,
    };
  }

  private createClient(store: InventoryProjectableStore): WooCommerceClient {
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

    throw new ConcurrentInventoryProjectionError();
  }
}

class ConcurrentInventoryProjectionError extends Error {
  constructor() {
    super('Concurrent inventory projection must be retried');
    this.name = 'ConcurrentInventoryProjectionError';
  }
}

function isConcurrentProjectionError(error: unknown): boolean {
  return (
    error instanceof ConcurrentInventoryProjectionError ||
    (error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'P2002' || error.code === 'P2034'))
  );
}
