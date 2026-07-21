import { Injectable, NotFoundException } from '@nestjs/common';
import { StoreStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../common/audit/audit.service';
import { EncryptionService } from '../common/encryption/encryption.service';
import {
  type TenantScopedStore,
  TenantScopedPrismaService,
  type TenantScopedStoreUpdate,
} from '../tenant/tenant-scoped-prisma.service';
import {
  type WooCommerceConnectionResult,
  WooCommerceClient,
} from '../woocommerce/client/woocommerce.client';
import type { CreateStoreDto } from './dto/create-store.dto';
import type { UpdateStoreDto } from './dto/update-store.dto';

@Injectable()
export class StoreService {
  constructor(
    private readonly tenantPrisma: TenantScopedPrismaService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService
  ) {}

  async create(input: CreateStoreDto): Promise<TenantScopedStore> {
    const store = await this.tenantPrisma.createStore({
      id: `sto_${randomUUID()}`,
      name: input.name,
      baseUrl: input.storeUrl,
      status: StoreStatus.ACTIVE,
      consumerKeyEncrypted: this.encryption.encrypt(input.consumerKey),
      consumerSecretEncrypted: this.encryption.encrypt(input.consumerSecret),
      webhookSecretEncrypted: '',
    });

    await this.audit.record({
      action: 'store.created',
      entity: 'Store',
      entityId: store.id,
      metadata: { status: store.status },
    });

    return store;
  }

  findAll(): Promise<TenantScopedStore[]> {
    return this.tenantPrisma.listActiveStores();
  }

  async findOne(storeId: string): Promise<TenantScopedStore> {
    const store = await this.tenantPrisma.findStoreById(storeId);

    if (!store) {
      throw new NotFoundException('Store was not found');
    }

    return store;
  }

  async update(
    storeId: string,
    input: UpdateStoreDto
  ): Promise<TenantScopedStore> {
    const update: TenantScopedStoreUpdate = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.storeUrl === undefined ? {} : { baseUrl: input.storeUrl }),
      ...(input.consumerKey === undefined
        ? {}
        : {
            consumerKeyEncrypted: this.encryption.encrypt(input.consumerKey),
          }),
      ...(input.consumerSecret === undefined
        ? {}
        : {
            consumerSecretEncrypted: this.encryption.encrypt(
              input.consumerSecret
            ),
          }),
    };
    const updated = await this.tenantPrisma.updateStore(storeId, update);

    if (!updated) {
      throw new NotFoundException('Store was not found');
    }

    const store = await this.findOne(storeId);

    await this.audit.record({
      action: 'store.updated',
      entity: 'Store',
      entityId: storeId,
      metadata: {
        changedFields: Object.keys(input).filter(
          (field) => field === 'name' || field === 'storeUrl'
        ),
        credentialsChanged:
          input.consumerKey !== undefined || input.consumerSecret !== undefined,
      },
    });

    return store;
  }

  async softDelete(storeId: string): Promise<void> {
    const deleted = await this.tenantPrisma.softDeleteStore(
      storeId,
      new Date()
    );

    if (!deleted) {
      throw new NotFoundException('Store was not found');
    }

    await this.audit.record({
      action: 'store.deleted',
      entity: 'Store',
      entityId: storeId,
    });
  }

  async testConnection(storeId: string): Promise<WooCommerceConnectionResult> {
    const store = await this.tenantPrisma.findStoreCredentialsById(storeId);

    if (!store) {
      throw new NotFoundException('Store was not found');
    }

    const client = new WooCommerceClient({
      storeUrl: store.baseUrl,
      consumerKey: this.encryption.decrypt(store.consumerKeyEncrypted),
      consumerSecret: this.encryption.decrypt(store.consumerSecretEncrypted),
    });

    const result = await client.testConnection();

    await this.audit.record({
      action: 'store.connection_tested',
      entity: 'Store',
      entityId: storeId,
      metadata: { success: result.success },
    });

    return result;
  }
}
