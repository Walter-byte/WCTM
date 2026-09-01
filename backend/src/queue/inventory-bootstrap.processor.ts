import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { InventorySyncState, StoreStatus } from '@prisma/client';
import { type Job, UnrecoverableError } from 'bullmq';

import { EncryptionService } from '../common/encryption/encryption.service';
import { ApplicationConfigService } from '../config/application-config.service';
import {
  InventoryProjectionFailure,
  InventoryProjectionService,
  type InventoryProjectableStore,
} from '../inventory/inventory-projection.service';
import {
  productRequiresVariationScan,
  readWooCommerceInventoryItemId,
} from '../inventory/inventory-payload.mapper';
import { PrismaService } from '../prisma/prisma.service';
import {
  type WooCommerceErrorCategory,
  WooCommerceClient,
  WooCommerceClientError,
} from '../woocommerce/client/woocommerce.client';
import {
  type InventoryBootstrapJobData,
  type InventoryBootstrapJobResult,
  InventoryBootstrapScheduler,
  validateInventoryBootstrapJobData,
} from './inventory-bootstrap.scheduler';
import { INVENTORY_BOOTSTRAP_JOB_NAME } from './queue.constants';

const BOOTSTRAP_PAGE_SIZE = 25;
const BOOTSTRAP_LEASE_MS = 30_000;
const RETRYABLE_CATEGORIES = new Set<WooCommerceErrorCategory>([
  'transport',
  'rate-limited',
  'timeout',
]);

interface ClaimedBootstrapStore extends InventoryProjectableStore {
  inventoryBootstrapProductPage: number;
  inventoryBootstrapVariationPage: number;
  inventoryBootstrapParentIds: string[];
  inventoryBootstrapProductsDone: boolean;
  inventoryBootstrapRevision: number;
  inventoryBootstrapLeaseAt: Date | null;
  inventorySyncState: InventorySyncState;
}

@Injectable()
export class InventoryBootstrapProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projection: InventoryProjectionService,
    @Inject(forwardRef(() => InventoryBootstrapScheduler))
    private readonly scheduler: InventoryBootstrapScheduler,
    private readonly encryption: EncryptionService,
    private readonly configuration: ApplicationConfigService
  ) {}

  async process(
    job: Job<
      InventoryBootstrapJobData,
      InventoryBootstrapJobResult,
      typeof INVENTORY_BOOTSTRAP_JOB_NAME
    >
  ): Promise<InventoryBootstrapJobResult> {
    validateInventoryBootstrapJobData(job.data);

    const claimedAt = new Date();
    const leaseCutoff = new Date(claimedAt.getTime() - BOOTSTRAP_LEASE_MS);
    const claimed = await this.prisma.store.updateMany({
      where: {
        id: job.data.storeId,
        tenantId: job.data.tenantId,
        status: StoreStatus.ACTIVE,
        deletedAt: null,
        inventorySyncState: InventorySyncState.SYNCING,
        inventoryBootstrapRevision: job.data.revision,
        OR: [
          { inventoryBootstrapLeaseAt: null },
          { inventoryBootstrapLeaseAt: { lte: leaseCutoff } },
        ],
      },
      data: { inventoryBootstrapLeaseAt: claimedAt },
    });

    if (claimed.count !== 1) {
      return this.resolveUnclaimed(job.data);
    }

    const store = await this.loadStore(job.data);

    if (!store) {
      throw new UnrecoverableError(
        'Inventory bootstrap Store is unavailable for processing'
      );
    }

    try {
      const ready = await this.processOneUnit(store, claimedAt);

      if (!ready) {
        const current = await this.loadStore(job.data);

        if (current && current.inventoryBootstrapRevision > job.data.revision) {
          await this.scheduler.enqueue({
            tenantId: current.tenantId,
            storeId: current.id,
            revision: current.inventoryBootstrapRevision,
          });
        }
      }

      return {
        tenantId: job.data.tenantId,
        storeId: job.data.storeId,
        processed: true,
        ready,
      };
    } catch (error: unknown) {
      await this.releaseLease(job.data, claimedAt);

      if (this.isRetryable(error)) {
        throw error instanceof Error
          ? error
          : new Error('Inventory bootstrap failed');
      }

      throw new UnrecoverableError(this.failureCode(error));
    }
  }

  async markFailed(value: unknown, error?: Error): Promise<void> {
    validateInventoryBootstrapJobData(value);

    await this.prisma.store.updateMany({
      where: {
        id: value.storeId,
        tenantId: value.tenantId,
        inventorySyncState: InventorySyncState.SYNCING,
        inventoryBootstrapRevision: value.revision,
      },
      data: {
        inventorySyncState: InventorySyncState.FAILED,
        inventoryBootstrapFailedAt: new Date(),
        inventoryBootstrapFailureCode: this.failureCode(error),
        inventoryBootstrapLeaseAt: null,
      },
    });
  }

  private async processOneUnit(
    store: ClaimedBootstrapStore,
    claimedAt: Date
  ): Promise<boolean> {
    const client = this.woocommerceClient(store);

    if (store.inventoryBootstrapParentIds.length > 0) {
      const parentWcProductId = store.inventoryBootstrapParentIds[0]!;
      let payload: unknown;

      try {
        payload = await client.fetchProductVariationsPage(
          parentWcProductId,
          store.inventoryBootstrapVariationPage,
          BOOTSTRAP_PAGE_SIZE
        );
      } catch (error: unknown) {
        // A product can disappear while the bounded bootstrap is in progress.
        // Its authenticated product.deleted event owns deactivation; skipping
        // this vanished parent keeps the scan resumable instead of wedging it.
        if (
          error instanceof WooCommerceClientError &&
          error.category === 'not-found'
        ) {
          payload = [];
        } else {
          throw error;
        }
      }
      const page = this.requirePage(payload);

      for (const item of page) {
        await this.projection.projectBootstrapPayload(store, item);
      }

      const parentComplete = page.length < BOOTSTRAP_PAGE_SIZE;
      const remainingParents = parentComplete
        ? store.inventoryBootstrapParentIds.slice(1)
        : store.inventoryBootstrapParentIds;
      const ready =
        store.inventoryBootstrapProductsDone && remainingParents.length === 0;

      await this.advance(
        store,
        claimedAt,
        {
          inventoryBootstrapParentIds: remainingParents,
          inventoryBootstrapVariationPage: parentComplete
            ? 1
            : store.inventoryBootstrapVariationPage + 1,
        },
        ready
      );
      return ready;
    }

    if (store.inventoryBootstrapProductsDone) {
      await this.advance(store, claimedAt, {}, true);
      return true;
    }

    const payload = await client.fetchProductsPage(
      store.inventoryBootstrapProductPage,
      BOOTSTRAP_PAGE_SIZE
    );
    const page = this.requirePage(payload);
    const parentIds: string[] = [];

    for (const item of page) {
      await this.projection.projectBootstrapPayload(store, item);

      if (productRequiresVariationScan(item)) {
        parentIds.push(readWooCommerceInventoryItemId(item));
      }
    }

    const productsDone = page.length < BOOTSTRAP_PAGE_SIZE;
    const ready = productsDone && parentIds.length === 0;

    await this.advance(
      store,
      claimedAt,
      {
        inventoryBootstrapProductPage: store.inventoryBootstrapProductPage + 1,
        inventoryBootstrapProductsDone: productsDone,
        inventoryBootstrapParentIds: [...new Set(parentIds)],
        inventoryBootstrapVariationPage: 1,
      },
      ready
    );
    return ready;
  }

  private requirePage(value: unknown): unknown[] {
    if (!Array.isArray(value) || value.length > BOOTSTRAP_PAGE_SIZE) {
      throw new InventoryProjectionFailure(
        'unexpected',
        'malformed-inventory-bootstrap-page',
        false
      );
    }

    return value;
  }

  private woocommerceClient(
    store: InventoryProjectableStore
  ): WooCommerceClient {
    return new WooCommerceClient({
      storeUrl: store.baseUrl,
      consumerKey: this.encryption.decrypt(store.consumerKeyEncrypted),
      consumerSecret: this.encryption.decrypt(store.consumerSecretEncrypted),
      resilience: this.configuration.woocommerce.rest,
    });
  }

  private async advance(
    store: ClaimedBootstrapStore,
    claimedAt: Date,
    progress: {
      inventoryBootstrapProductPage?: number;
      inventoryBootstrapVariationPage?: number;
      inventoryBootstrapParentIds?: string[];
      inventoryBootstrapProductsDone?: boolean;
    },
    ready: boolean
  ): Promise<void> {
    const advanced = await this.prisma.store.updateMany({
      where: {
        id: store.id,
        tenantId: store.tenantId,
        inventorySyncState: InventorySyncState.SYNCING,
        inventoryBootstrapRevision: store.inventoryBootstrapRevision,
        inventoryBootstrapLeaseAt: claimedAt,
      },
      data: {
        ...progress,
        inventorySyncState: ready
          ? InventorySyncState.READY
          : InventorySyncState.SYNCING,
        inventoryBootstrapCompletedAt: ready ? new Date() : undefined,
        inventoryBootstrapFailedAt: null,
        inventoryBootstrapFailureCode: null,
        inventoryBootstrapLeaseAt: null,
        inventoryBootstrapRevision: { increment: 1 },
      },
    });

    if (advanced.count !== 1) {
      throw new Error('Inventory bootstrap progress could not be persisted');
    }
  }

  private async resolveUnclaimed(
    data: InventoryBootstrapJobData
  ): Promise<InventoryBootstrapJobResult> {
    const store = await this.loadStore(data);

    if (!store) {
      throw new UnrecoverableError(
        'Inventory bootstrap Store is unavailable for processing'
      );
    }

    if (store.inventorySyncState === InventorySyncState.READY) {
      return {
        tenantId: data.tenantId,
        storeId: data.storeId,
        processed: true,
        ready: true,
      };
    }

    if (store.inventoryBootstrapRevision > data.revision) {
      await this.scheduler.enqueue({
        tenantId: store.tenantId,
        storeId: store.id,
        revision: store.inventoryBootstrapRevision,
      });
      return {
        tenantId: data.tenantId,
        storeId: data.storeId,
        processed: true,
        ready: false,
      };
    }

    if (
      store.inventoryBootstrapRevision === data.revision &&
      store.inventoryBootstrapLeaseAt !== null
    ) {
      throw new Error('Inventory bootstrap revision is already leased');
    }

    throw new UnrecoverableError('Inventory bootstrap job is no longer active');
  }

  private loadStore(
    data: Pick<InventoryBootstrapJobData, 'tenantId' | 'storeId'>
  ): Promise<ClaimedBootstrapStore | null> {
    return this.prisma.store.findFirst({
      where: {
        id: data.storeId,
        tenantId: data.tenantId,
        status: StoreStatus.ACTIVE,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: {
        id: true,
        tenantId: true,
        baseUrl: true,
        consumerKeyEncrypted: true,
        consumerSecretEncrypted: true,
        inventoryBootstrapProductPage: true,
        inventoryBootstrapVariationPage: true,
        inventoryBootstrapParentIds: true,
        inventoryBootstrapProductsDone: true,
        inventoryBootstrapRevision: true,
        inventoryBootstrapLeaseAt: true,
        inventorySyncState: true,
      },
    }) as Promise<ClaimedBootstrapStore | null>;
  }

  private releaseLease(
    data: InventoryBootstrapJobData,
    claimedAt: Date
  ): Promise<{ count: number }> {
    return this.prisma.store.updateMany({
      where: {
        id: data.storeId,
        tenantId: data.tenantId,
        inventorySyncState: InventorySyncState.SYNCING,
        inventoryBootstrapRevision: data.revision,
        inventoryBootstrapLeaseAt: claimedAt,
      },
      data: { inventoryBootstrapLeaseAt: null },
    });
  }

  private isRetryable(error: unknown): boolean {
    return (
      (error instanceof WooCommerceClientError &&
        RETRYABLE_CATEGORIES.has(error.category)) ||
      (error instanceof InventoryProjectionFailure && error.retryable)
    );
  }

  private failureCode(error: unknown): string {
    if (error instanceof InventoryProjectionFailure) {
      return error.code.slice(0, 191);
    }

    if (error instanceof WooCommerceClientError) {
      return `woocommerce-${error.category}`;
    }

    if (error instanceof UnrecoverableError) {
      return error.message.slice(0, 191);
    }

    return 'inventory-bootstrap-failed';
  }
}
