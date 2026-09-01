import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { InventorySyncState, StoreStatus } from '@prisma/client';
import { UnrecoverableError } from 'bullmq';

import { PrismaService } from '../prisma/prisma.service';
import { QueueRuntimeService } from './queue-runtime.service';

export interface InventoryBootstrapJobData {
  tenantId: string;
  storeId: string;
  revision: number;
}

export interface InventoryBootstrapJobResult {
  tenantId: string;
  storeId: string;
  processed: true;
  ready: boolean;
}

const TENANT_ID_PATTERN = /^ten_[A-Za-z0-9-]{1,60}$/;
const STORE_ID_PATTERN = /^sto_[A-Za-z0-9-]{1,60}$/;

export function validateInventoryBootstrapJobData(
  value: unknown
): asserts value is InventoryBootstrapJobData {
  if (value === null || typeof value !== 'object') {
    throw new UnrecoverableError(
      'Inventory bootstrap job payload must be an object'
    );
  }

  const data = value as Partial<InventoryBootstrapJobData>;

  if (
    typeof data.tenantId !== 'string' ||
    !TENANT_ID_PATTERN.test(data.tenantId)
  ) {
    throw new UnrecoverableError(
      'Inventory bootstrap tenant identity is required and must be valid'
    );
  }

  if (
    typeof data.storeId !== 'string' ||
    !STORE_ID_PATTERN.test(data.storeId)
  ) {
    throw new UnrecoverableError(
      'Inventory bootstrap Store identity is required and must be valid'
    );
  }

  if (
    typeof data.revision !== 'number' ||
    !Number.isSafeInteger(data.revision) ||
    data.revision < 0
  ) {
    throw new UnrecoverableError(
      'Inventory bootstrap revision is required and must be valid'
    );
  }
}

@Injectable()
export class InventoryBootstrapScheduler {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => QueueRuntimeService))
    private readonly queueRuntime: QueueRuntimeService
  ) {}

  async ensureInitialized(
    tenantId: string,
    storeId: string
  ): Promise<{
    previousState: InventorySyncState;
    state: InventorySyncState;
    enqueueFailed?: boolean;
  }> {
    const store = await this.prisma.store.findFirst({
      where: {
        id: storeId,
        tenantId,
        status: StoreStatus.ACTIVE,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: { inventorySyncState: true },
    });

    if (!store) {
      throw new Error('Inventory Store context is unavailable');
    }

    const previousState = store.inventorySyncState;

    if (previousState === InventorySyncState.READY) {
      return { previousState, state: InventorySyncState.READY };
    }

    if (
      previousState === InventorySyncState.UNINITIALIZED ||
      previousState === InventorySyncState.FAILED
    ) {
      await this.prisma.store.updateMany({
        where: {
          id: storeId,
          tenantId,
          inventorySyncState: previousState,
          status: StoreStatus.ACTIVE,
          deletedAt: null,
        },
        data: {
          inventorySyncState: InventorySyncState.SYNCING,
          inventoryBootstrapStartedAt:
            previousState === InventorySyncState.UNINITIALIZED
              ? new Date()
              : undefined,
          inventoryBootstrapFailedAt: null,
          inventoryBootstrapFailureCode: null,
          inventoryBootstrapLeaseAt: null,
          inventoryBootstrapRevision: { increment: 1 },
        },
      });
    }

    const current = await this.prisma.store.findFirst({
      where: {
        id: storeId,
        tenantId,
        status: StoreStatus.ACTIVE,
        deletedAt: null,
      },
      select: {
        inventorySyncState: true,
        inventoryBootstrapRevision: true,
      },
    });

    if (!current) {
      throw new Error('Inventory Store context is unavailable');
    }

    if (current.inventorySyncState === InventorySyncState.READY) {
      return { previousState, state: InventorySyncState.READY };
    }

    if (current.inventorySyncState !== InventorySyncState.SYNCING) {
      return { previousState, state: current.inventorySyncState };
    }

    try {
      await this.enqueue({
        tenantId,
        storeId,
        revision: current.inventoryBootstrapRevision,
      });

      await this.prisma.store.updateMany({
        where: {
          id: storeId,
          tenantId,
          inventorySyncState: InventorySyncState.SYNCING,
          inventoryBootstrapRevision: current.inventoryBootstrapRevision,
          inventoryBootstrapFailureCode: 'bootstrap-enqueue-failed',
        },
        data: {
          inventoryBootstrapFailedAt: null,
          inventoryBootstrapFailureCode: null,
        },
      });
    } catch {
      await this.prisma.store.updateMany({
        where: {
          id: storeId,
          tenantId,
          inventorySyncState: InventorySyncState.SYNCING,
          inventoryBootstrapRevision: current.inventoryBootstrapRevision,
        },
        data: {
          inventoryBootstrapFailedAt: new Date(),
          inventoryBootstrapFailureCode: 'bootstrap-enqueue-failed',
          inventoryBootstrapLeaseAt: null,
        },
      });
      return {
        previousState,
        state: InventorySyncState.SYNCING,
        enqueueFailed: true,
      };
    }

    return { previousState, state: InventorySyncState.SYNCING };
  }

  enqueue(data: InventoryBootstrapJobData): Promise<{ jobId: string }> {
    validateInventoryBootstrapJobData(data);
    return this.queueRuntime.addInventoryBootstrapJob(
      data,
      inventoryBootstrapJobId(data.storeId, data.revision)
    );
  }
}

export const inventoryBootstrapJobId = (
  storeId: string,
  revision: number
): string => `inventory-bootstrap-${storeId}-${revision}`;
