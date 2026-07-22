import { Injectable } from '@nestjs/common';
import { MembershipRole, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from './tenant-context.service';

const STORE_SUMMARY_SELECT = {
  id: true,
  tenantId: true,
  name: true,
  baseUrl: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.StoreSelect;

const STORE_CREDENTIALS_SELECT = {
  id: true,
  tenantId: true,
  baseUrl: true,
  consumerKeyEncrypted: true,
  consumerSecretEncrypted: true,
} satisfies Prisma.StoreSelect;

const STORE_CONNECTION_HEALTH_SELECT = {
  status: true,
  lastSeenAt: true,
  lastHealthyAt: true,
  pluginRegisteredAt: true,
} satisfies Prisma.StoreSelect;

const TENANT_SUMMARY_SELECT = {
  id: true,
  name: true,
  plan: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TenantSelect;

export const MEMBERSHIP_SUMMARY_SELECT = {
  id: true,
  tenantId: true,
  userId: true,
  role: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      email: true,
      displayName: true,
    },
  },
} satisfies Prisma.MembershipSelect;

const MEMBERSHIP_RECORD_SELECT = {
  id: true,
  tenantId: true,
  userId: true,
  role: true,
  deletedAt: true,
} satisfies Prisma.MembershipSelect;

export type TenantScopedStore = Prisma.StoreGetPayload<{
  select: typeof STORE_SUMMARY_SELECT;
}>;

export type TenantScopedStoreCredentials = Prisma.StoreGetPayload<{
  select: typeof STORE_CREDENTIALS_SELECT;
}>;

export type TenantScopedStoreConnectionHealth = Prisma.StoreGetPayload<{
  select: typeof STORE_CONNECTION_HEALTH_SELECT;
}>;

export interface TenantScopedStoreCreate {
  id: string;
  name: string;
  baseUrl: string;
  status: Prisma.StoreCreateInput['status'];
  consumerKeyEncrypted: string;
  consumerSecretEncrypted: string;
  webhookSecretEncrypted: string;
}

export interface TenantScopedStoreUpdate {
  name?: string;
  baseUrl?: string;
  consumerKeyEncrypted?: string;
  consumerSecretEncrypted?: string;
}

export type TenantSummary = Prisma.TenantGetPayload<{
  select: typeof TENANT_SUMMARY_SELECT;
}>;

export type MembershipSummary = Prisma.MembershipGetPayload<{
  select: typeof MEMBERSHIP_SUMMARY_SELECT;
}>;

export type MembershipRecord = Prisma.MembershipGetPayload<{
  select: typeof MEMBERSHIP_RECORD_SELECT;
}>;

@Injectable()
export class TenantScopedPrismaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService
  ) {}

  findActiveTenant(): Promise<TenantSummary | null> {
    return this.prisma.tenant.findFirst({
      where: {
        id: this.tenantContext.active.tenantId,
        deletedAt: null,
      },
      select: TENANT_SUMMARY_SELECT,
    });
  }

  async updateActiveTenantName(name: string): Promise<boolean> {
    const result = await this.prisma.tenant.updateMany({
      where: {
        id: this.tenantContext.active.tenantId,
        deletedAt: null,
      },
      data: { name },
    });

    return result.count === 1;
  }

  async softDeleteActiveTenant(deletedAt: Date): Promise<boolean> {
    const result = await this.prisma.tenant.updateMany({
      where: {
        id: this.tenantContext.active.tenantId,
        deletedAt: null,
      },
      data: { deletedAt },
    });

    return result.count === 1;
  }

  listActiveMemberships(): Promise<MembershipSummary[]> {
    return this.prisma.membership.findMany({
      where: {
        tenantId: this.tenantContext.active.tenantId,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: MEMBERSHIP_SUMMARY_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  findActiveMembershipById(
    membershipId: string
  ): Promise<MembershipSummary | null> {
    return this.prisma.membership.findFirst({
      where: {
        id: membershipId,
        tenantId: this.tenantContext.active.tenantId,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: MEMBERSHIP_SUMMARY_SELECT,
    });
  }

  findMembershipRecordByUserId(
    userId: string
  ): Promise<MembershipRecord | null> {
    return this.prisma.membership.findUnique({
      where: {
        tenantId_userId: {
          tenantId: this.tenantContext.active.tenantId,
          userId,
        },
      },
      select: MEMBERSHIP_RECORD_SELECT,
    });
  }

  createMembership(
    membershipId: string,
    userId: string,
    role: MembershipRole
  ): Promise<MembershipRecord> {
    return this.prisma.membership.create({
      data: {
        id: membershipId,
        tenantId: this.tenantContext.active.tenantId,
        userId,
        role,
      },
      select: MEMBERSHIP_RECORD_SELECT,
    });
  }

  async reactivateMembership(
    membershipId: string,
    role: MembershipRole
  ): Promise<boolean> {
    const result = await this.prisma.membership.updateMany({
      where: {
        id: membershipId,
        tenantId: this.tenantContext.active.tenantId,
        deletedAt: { not: null },
      },
      data: { role, deletedAt: null },
    });

    return result.count === 1;
  }

  findStoreById(storeId: string): Promise<TenantScopedStore | null> {
    return this.prisma.store.findFirst({
      where: {
        id: storeId,
        tenantId: this.tenantContext.active.tenantId,
        deletedAt: null,
      },
      select: STORE_SUMMARY_SELECT,
    });
  }

  listActiveStores(): Promise<TenantScopedStore[]> {
    return this.prisma.store.findMany({
      where: {
        tenantId: this.tenantContext.active.tenantId,
        deletedAt: null,
      },
      select: STORE_SUMMARY_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  createStore(input: TenantScopedStoreCreate): Promise<TenantScopedStore> {
    return this.prisma.store.create({
      data: {
        ...input,
        tenantId: this.tenantContext.active.tenantId,
      },
      select: STORE_SUMMARY_SELECT,
    });
  }

  async updateStore(
    storeId: string,
    input: TenantScopedStoreUpdate
  ): Promise<boolean> {
    const result = await this.prisma.store.updateMany({
      where: {
        id: storeId,
        tenantId: this.tenantContext.active.tenantId,
        deletedAt: null,
      },
      data: input,
    });

    return result.count === 1;
  }

  async softDeleteStore(storeId: string, deletedAt: Date): Promise<boolean> {
    const result = await this.prisma.store.updateMany({
      where: {
        id: storeId,
        tenantId: this.tenantContext.active.tenantId,
        deletedAt: null,
      },
      data: { deletedAt },
    });

    return result.count === 1;
  }

  findStoreCredentialsById(
    storeId: string
  ): Promise<TenantScopedStoreCredentials | null> {
    return this.prisma.store.findFirst({
      where: {
        id: storeId,
        tenantId: this.tenantContext.active.tenantId,
        deletedAt: null,
      },
      select: STORE_CREDENTIALS_SELECT,
    });
  }

  async issueStoreRegistrationToken(
    storeId: string,
    tokenHash: string,
    expiresAt: Date
  ): Promise<boolean> {
    const result = await this.prisma.store.updateMany({
      where: {
        id: storeId,
        tenantId: this.tenantContext.active.tenantId,
        deletedAt: null,
      },
      data: {
        registrationTokenHash: tokenHash,
        registrationTokenExpiresAt: expiresAt,
        registrationTokenConsumedAt: null,
      },
    });

    return result.count === 1;
  }

  findStoreConnectionHealth(
    storeId: string
  ): Promise<TenantScopedStoreConnectionHealth | null> {
    return this.prisma.store.findFirst({
      where: {
        id: storeId,
        tenantId: this.tenantContext.active.tenantId,
        deletedAt: null,
      },
      select: STORE_CONNECTION_HEALTH_SELECT,
    });
  }

  async updateStoreName(storeId: string, name: string): Promise<boolean> {
    const result = await this.prisma.store.updateMany({
      where: {
        id: storeId,
        tenantId: this.tenantContext.active.tenantId,
        deletedAt: null,
      },
      data: { name },
    });

    return result.count === 1;
  }
}
