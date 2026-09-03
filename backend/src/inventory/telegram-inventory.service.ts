import { Injectable } from '@nestjs/common';
import {
  InventoryAlertClassification,
  InventoryAlertLevel,
  InventorySyncState,
  MembershipRole,
  NotificationCategory,
  NotificationRecipientMode,
  Prisma,
  StoreStatus,
  TelegramChatType,
  TelegramInventoryReferencePurpose,
} from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { ApplicationConfigService } from '../config/application-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryBootstrapScheduler } from '../queue/inventory-bootstrap.scheduler';
import type { TelegramOrderIdentityDto } from '../telegram/dto/telegram-internal.dto';
import type { TelegramOrderNotificationRecipient } from '../telegram/telegram-order.service';

const PAGE_SIZE = 8;
const MAX_REACHABLE = 200;
const REFERENCE_ID_BYTES = 12;
const REFERENCE_SIGNATURE_BYTES = 12;
const ALLOWED_ROLES = [
  MembershipRole.OWNER,
  MembershipRole.ADMIN,
  MembershipRole.MEMBER,
] as const;

interface InventoryContext {
  accountId: string;
  membershipId: string;
  telegramChatId: bigint;
  tenantId: string;
  storeId: string;
}

type ContextResolution =
  | { state: 'UNAUTHORIZED' | 'NO_ACTIVE_STORE' }
  | { state: 'OK'; context: InventoryContext };

export interface TelegramStockItemSummary {
  ref: string;
  displayName: string;
  sku: string | null;
  quantity: string | null;
  stockStatus: string;
  classification: 'HEALTHY' | 'LOW_STOCK' | 'OUT_OF_STOCK';
  kind: 'PRODUCT' | 'VARIATION';
}

export interface TelegramStockItemDetail extends Omit<
  TelegramStockItemSummary,
  'ref'
> {
  variationContext: Array<{ name: string; option: string }>;
  threshold: number | null;
  lastSyncedAt: string;
}

export type TelegramStockListResult =
  | {
      state:
        | 'SYNCING'
        | 'SYNC_FAILED'
        | 'NO_ACTIVE_STORE'
        | 'UNAUTHORIZED'
        | 'CONTEXT_CHANGED';
      items: [];
      nextCursor: null;
      previousCursor: null;
      threshold: number | null;
    }
  | {
      state: 'OK';
      items: TelegramStockItemSummary[];
      nextCursor: string | null;
      previousCursor: string | null;
      threshold: number | null;
    };

export type TelegramStockDetailResult =
  | {
      state:
        'NOT_FOUND' | 'NO_ACTIVE_STORE' | 'UNAUTHORIZED' | 'CONTEXT_CHANGED';
    }
  | { state: 'OK'; item: TelegramStockItemDetail; backCursor: string };

export type TelegramProjectedStockDetailResult =
  | {
      state:
        | 'NOT_FOUND'
        | 'NO_ACTIVE_STORE'
        | 'UNAUTHORIZED'
        | 'CONTEXT_CHANGED'
        | 'SYNCING';
    }
  | { state: 'OK'; item: TelegramStockItemDetail };

export type TelegramPreparedInventoryNotification =
  | { state: 'UNAUTHORIZED' | 'NOT_FOUND' | 'DISABLED' | 'STALE' }
  | {
      state: 'OK';
      displayName: string;
      sku: string | null;
      quantity: string | null;
      stockStatus: string;
      classification: 'LOW_STOCK' | 'OUT_OF_STOCK';
      threshold: number | null;
      viewStockRef: string;
    };

const INVENTORY_REFERENCE_SELECT = {
  id: true,
  telegramAccountId: true,
  telegramChatId: true,
  tenantId: true,
  storeId: true,
  purpose: true,
  pageOffset: true,
  inventoryItemId: true,
  backReferenceId: true,
  expiresAt: true,
} satisfies Prisma.TelegramInventoryReferenceSelect;

type InventoryReference = Prisma.TelegramInventoryReferenceGetPayload<{
  select: typeof INVENTORY_REFERENCE_SELECT;
}>;

@Injectable()
export class TelegramInventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configuration: ApplicationConfigService,
    private readonly bootstrap: InventoryBootstrapScheduler
  ) {}

  async list(input: {
    telegram: TelegramOrderIdentityDto;
    cursor?: string;
  }): Promise<TelegramStockListResult> {
    const resolved = await this.resolveContext(input.telegram);

    if (resolved.state !== 'OK') {
      return this.emptyList(resolved.state, null);
    }

    const context = resolved.context;
    const store = await this.loadStore(context);

    if (!store) {
      return this.emptyList('NO_ACTIVE_STORE', null);
    }

    const initialization = await this.bootstrap.ensureInitialized(
      context.tenantId,
      context.storeId
    );

    if (
      initialization.previousState === InventorySyncState.FAILED ||
      initialization.enqueueFailed
    ) {
      return this.emptyList('SYNC_FAILED', store.lowStockThreshold);
    }

    if (initialization.state !== InventorySyncState.READY) {
      return this.emptyList(
        initialization.state === InventorySyncState.FAILED
          ? 'SYNC_FAILED'
          : 'SYNCING',
        store.lowStockThreshold
      );
    }

    let offset = 0;

    if (input.cursor) {
      const reference = await this.validateReference(
        input.cursor,
        'k',
        TelegramInventoryReferencePurpose.LIST_PAGE,
        context
      );

      if (
        reference?.pageOffset === null ||
        reference?.pageOffset === undefined
      ) {
        return this.emptyList('CONTEXT_CHANGED', store.lowStockThreshold);
      }

      offset = reference.pageOffset;
    }

    const records = await this.prisma.inventoryItem.findMany({
      where: {
        tenantId: context.tenantId,
        storeId: context.storeId,
        remoteDeletedAt: null,
        alertClassification: {
          in: [
            InventoryAlertClassification.OUT_OF_STOCK,
            InventoryAlertClassification.LOW_STOCK,
          ],
        },
      },
      select: {
        id: true,
        displayName: true,
        sku: true,
        stockQuantity: true,
        stockStatus: true,
        alertClassification: true,
        kind: true,
      },
      orderBy: [
        { alertClassification: 'asc' },
        { stockQuantity: { sort: 'asc', nulls: 'last' } },
        { displayName: 'asc' },
        { wcItemId: 'asc' },
      ],
      skip: offset,
      take: PAGE_SIZE + 1,
    });
    const page = records.slice(0, PAGE_SIZE);
    const expiresAt = this.referenceExpiry();
    const current = this.newReference(
      'k',
      context,
      {
        purpose: TelegramInventoryReferencePurpose.LIST_PAGE,
        pageOffset: offset,
      },
      expiresAt
    );
    const references: Prisma.TelegramInventoryReferenceCreateManyInput[] = [
      current.data,
    ];
    const items = page.map((item) => {
      const detail = this.newReference(
        'v',
        context,
        {
          purpose: TelegramInventoryReferencePurpose.ITEM_DETAIL,
          inventoryItemId: item.id,
          backReferenceId: current.data.id,
        },
        expiresAt
      );
      references.push(detail.data);
      return this.toSummary(item, detail.token);
    });
    let previousCursor: string | null = null;
    let nextCursor: string | null = null;

    if (offset > 0) {
      const previous = this.newReference(
        'k',
        context,
        {
          purpose: TelegramInventoryReferencePurpose.LIST_PAGE,
          pageOffset: Math.max(0, offset - PAGE_SIZE),
        },
        expiresAt
      );
      references.push(previous.data);
      previousCursor = previous.token;
    }

    if (records.length > PAGE_SIZE && offset + PAGE_SIZE < MAX_REACHABLE) {
      const next = this.newReference(
        'k',
        context,
        {
          purpose: TelegramInventoryReferencePurpose.LIST_PAGE,
          pageOffset: offset + PAGE_SIZE,
        },
        expiresAt
      );
      references.push(next.data);
      nextCursor = next.token;
    }

    await this.prisma.telegramInventoryReference.createMany({
      data: references,
    });

    return {
      state: 'OK',
      items,
      nextCursor,
      previousCursor,
      threshold: store.lowStockThreshold,
    };
  }

  async detail(input: {
    telegram: TelegramOrderIdentityDto;
    ref: string;
  }): Promise<TelegramStockDetailResult> {
    const resolved = await this.resolveContext(input.telegram);

    if (resolved.state !== 'OK') {
      return { state: resolved.state };
    }

    const context = resolved.context;
    const reference = await this.validateReference(
      input.ref,
      'v',
      TelegramInventoryReferencePurpose.ITEM_DETAIL,
      context
    );

    if (!reference?.inventoryItemId || !reference.backReferenceId) {
      return { state: 'CONTEXT_CHANGED' };
    }

    const back = await this.prisma.telegramInventoryReference.findFirst({
      where: {
        id: reference.backReferenceId,
        telegramAccountId: context.accountId,
        telegramChatId: context.telegramChatId,
        tenantId: context.tenantId,
        storeId: context.storeId,
        purpose: TelegramInventoryReferencePurpose.LIST_PAGE,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });

    if (!back) {
      return { state: 'CONTEXT_CHANGED' };
    }

    const item = await this.prisma.inventoryItem.findFirst({
      where: {
        id: reference.inventoryItemId,
        tenantId: context.tenantId,
        storeId: context.storeId,
        remoteDeletedAt: null,
        alertClassification: {
          in: [
            InventoryAlertClassification.OUT_OF_STOCK,
            InventoryAlertClassification.LOW_STOCK,
          ],
        },
      },
      select: {
        displayName: true,
        sku: true,
        stockQuantity: true,
        stockStatus: true,
        alertClassification: true,
        kind: true,
        variationContext: true,
        lastSyncedAt: true,
        store: { select: { lowStockThreshold: true } },
      },
    });

    if (!item) {
      return { state: 'NOT_FOUND' };
    }

    const summary = this.toSummary(item, '');

    return {
      state: 'OK',
      item: {
        displayName: summary.displayName,
        sku: summary.sku,
        quantity: summary.quantity,
        stockStatus: summary.stockStatus,
        classification: summary.classification,
        kind: summary.kind,
        variationContext: this.readVariationContext(item.variationContext),
        threshold: item.store.lowStockThreshold,
        lastSyncedAt: item.lastSyncedAt.toISOString(),
      },
      backCursor: this.tokenForReferenceId('k', back.id),
    };
  }

  async openProjectedDetail(input: {
    telegram: TelegramOrderIdentityDto;
    inventoryItemId: string;
  }): Promise<TelegramProjectedStockDetailResult> {
    const resolved = await this.resolveContext(input.telegram);

    if (resolved.state !== 'OK') {
      return { state: resolved.state };
    }

    const context = resolved.context;
    const store = await this.loadStore(context);

    if (!store) {
      return { state: 'NO_ACTIVE_STORE' };
    }

    if (store.inventorySyncState !== InventorySyncState.READY) {
      return { state: 'SYNCING' };
    }

    const item = await this.prisma.inventoryItem.findFirst({
      where: {
        id: input.inventoryItemId,
        tenantId: context.tenantId,
        storeId: context.storeId,
        remoteDeletedAt: null,
      },
      select: {
        displayName: true,
        sku: true,
        stockQuantity: true,
        stockStatus: true,
        alertClassification: true,
        kind: true,
        variationContext: true,
        lastSyncedAt: true,
        store: { select: { lowStockThreshold: true } },
      },
    });

    if (!item) {
      return { state: 'NOT_FOUND' };
    }

    const summary = this.toSummary(item, '');

    return {
      state: 'OK',
      item: {
        displayName: summary.displayName,
        sku: summary.sku,
        quantity: summary.quantity,
        stockStatus: summary.stockStatus,
        classification: summary.classification,
        kind: summary.kind,
        variationContext: this.readVariationContext(item.variationContext),
        threshold: item.store.lowStockThreshold,
        lastSyncedAt: item.lastSyncedAt.toISOString(),
      },
    };
  }

  async prepareNotification(
    recipient: TelegramOrderNotificationRecipient,
    tenantId: string,
    storeId: string,
    inventoryItemId: string,
    incidentGeneration: number,
    alertLevel: InventoryAlertLevel,
    policyVersion: number
  ): Promise<TelegramPreparedInventoryNotification> {
    const resolved = await this.resolveContext({
      userId: recipient.telegramUserId,
      chatId: recipient.telegramChatId,
    });

    if (
      resolved.state !== 'OK' ||
      resolved.context.accountId !== recipient.telegramAccountId ||
      (recipient.membershipId !== undefined &&
        resolved.context.membershipId !== recipient.membershipId) ||
      resolved.context.tenantId !== tenantId ||
      resolved.context.storeId !== storeId
    ) {
      return { state: 'UNAUTHORIZED' };
    }

    const context = resolved.context;
    const policy = await this.prisma.store.findFirst({
      where: {
        id: storeId,
        tenantId,
        status: StoreStatus.ACTIVE,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: {
        lowStockThreshold: true,
        enabledNotificationCategories: true,
        notificationRecipientMode: true,
        inventoryNotificationPolicyVersion: true,
        selectedNotificationRecipients: {
          where: { membershipId: context.membershipId },
          select: { id: true },
          take: 1,
        },
      },
    });

    if (
      !policy ||
      !policy.enabledNotificationCategories.includes(
        NotificationCategory.LOW_STOCK
      ) ||
      policy.inventoryNotificationPolicyVersion !== policyVersion ||
      (policy.notificationRecipientMode ===
        NotificationRecipientMode.SELECTED &&
        policy.selectedNotificationRecipients.length === 0)
    ) {
      return { state: 'DISABLED' };
    }

    const expectedClassification =
      alertLevel === InventoryAlertLevel.OUT_OF_STOCK
        ? InventoryAlertClassification.OUT_OF_STOCK
        : InventoryAlertClassification.LOW_STOCK;
    const item = await this.prisma.inventoryItem.findFirst({
      where: {
        id: inventoryItemId,
        tenantId,
        storeId,
        remoteDeletedAt: null,
      },
      select: {
        id: true,
        incidentGeneration: true,
        alertClassification: true,
        displayName: true,
        sku: true,
        stockQuantity: true,
        stockStatus: true,
        kind: true,
      },
    });

    if (!item) {
      return { state: 'NOT_FOUND' };
    }

    if (
      item.incidentGeneration !== incidentGeneration ||
      item.alertClassification !== expectedClassification
    ) {
      return { state: 'STALE' };
    }

    const expiresAt = this.referenceExpiry();
    const list = this.newReference(
      'k',
      context,
      {
        purpose: TelegramInventoryReferencePurpose.LIST_PAGE,
        pageOffset: 0,
      },
      expiresAt
    );
    const detail = this.newReference(
      'v',
      context,
      {
        purpose: TelegramInventoryReferencePurpose.ITEM_DETAIL,
        inventoryItemId: item.id,
        backReferenceId: list.data.id,
      },
      expiresAt
    );

    await this.prisma.telegramInventoryReference.createMany({
      data: [list.data, detail.data],
    });
    const summary = this.toSummary(item, detail.token);

    return {
      state: 'OK',
      displayName: summary.displayName,
      sku: summary.sku,
      quantity: summary.quantity,
      stockStatus: summary.stockStatus,
      classification:
        alertLevel === InventoryAlertLevel.OUT_OF_STOCK
          ? 'OUT_OF_STOCK'
          : 'LOW_STOCK',
      threshold: policy.lowStockThreshold,
      viewStockRef: detail.token,
    };
  }

  private async resolveContext(
    identity: TelegramOrderIdentityDto
  ): Promise<ContextResolution> {
    const telegramUserId = BigInt(identity.userId);
    const telegramChatId = BigInt(identity.chatId);
    const account = await this.prisma.telegramAccount.findUnique({
      where: { telegramUserId },
      select: {
        id: true,
        userId: true,
        deletedAt: true,
        chatAuthorizations: {
          where: {
            telegramChatId,
            chatType: TelegramChatType.PRIVATE,
            revokedAt: null,
          },
          select: { telegramAccountId: true },
        },
      },
    });

    if (
      !account ||
      account.deletedAt ||
      account.chatAuthorizations.length !== 1 ||
      account.chatAuthorizations[0]?.telegramAccountId !== account.id
    ) {
      return { state: 'UNAUTHORIZED' };
    }

    const memberships = await this.prisma.membership.findMany({
      where: {
        userId: account.userId,
        deletedAt: null,
        tenant: { deletedAt: null },
        role: { in: [...ALLOWED_ROLES] },
      },
      select: { id: true, tenantId: true },
      take: 2,
    });

    if (memberships.length === 0) {
      return { state: 'UNAUTHORIZED' };
    }

    if (memberships.length !== 1) {
      return { state: 'NO_ACTIVE_STORE' };
    }

    const membership = memberships[0]!;
    const stores = await this.prisma.store.findMany({
      where: {
        tenantId: membership.tenantId,
        status: StoreStatus.ACTIVE,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: { id: true },
      take: 2,
    });

    if (stores.length !== 1) {
      return { state: 'NO_ACTIVE_STORE' };
    }

    return {
      state: 'OK',
      context: {
        accountId: account.id,
        membershipId: membership.id,
        telegramChatId,
        tenantId: membership.tenantId,
        storeId: stores[0]!.id,
      },
    };
  }

  private loadStore(context: InventoryContext) {
    return this.prisma.store.findFirst({
      where: {
        id: context.storeId,
        tenantId: context.tenantId,
        status: StoreStatus.ACTIVE,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: {
        lowStockThreshold: true,
        inventorySyncState: true,
      },
    });
  }

  private async validateReference(
    token: string,
    prefix: 'k' | 'v',
    purpose: TelegramInventoryReferencePurpose,
    context: InventoryContext
  ): Promise<InventoryReference | undefined> {
    const parsed = this.parseToken(token, prefix);

    if (!parsed) {
      return undefined;
    }

    const reference = await this.prisma.telegramInventoryReference.findUnique({
      where: { id: parsed.referenceId },
      select: INVENTORY_REFERENCE_SELECT,
    });

    if (
      !reference ||
      reference.expiresAt <= new Date() ||
      reference.purpose !== purpose ||
      reference.telegramAccountId !== context.accountId ||
      reference.telegramChatId !== context.telegramChatId ||
      reference.tenantId !== context.tenantId ||
      reference.storeId !== context.storeId
    ) {
      return undefined;
    }

    return reference;
  }

  private newReference(
    prefix: 'k' | 'v',
    context: InventoryContext,
    values: Pick<
      Prisma.TelegramInventoryReferenceCreateManyInput,
      'purpose' | 'pageOffset' | 'inventoryItemId' | 'backReferenceId'
    >,
    expiresAt: Date
  ) {
    const shortId = randomBytes(REFERENCE_ID_BYTES).toString('base64url');
    const id = `tir_${shortId}`;

    return {
      token: this.tokenForReferenceId(prefix, id),
      data: {
        id,
        telegramAccountId: context.accountId,
        telegramChatId: context.telegramChatId,
        tenantId: context.tenantId,
        storeId: context.storeId,
        expiresAt,
        ...values,
      } satisfies Prisma.TelegramInventoryReferenceCreateManyInput,
    };
  }

  private tokenForReferenceId(prefix: 'k' | 'v', referenceId: string): string {
    const shortId = referenceId.replace(/^tir_/, '');
    const signed = `${prefix}.${shortId}`;
    const signature = createHmac(
      'sha256',
      this.configuration.telegram.callbackSigningKey
    )
      .update(signed)
      .digest()
      .subarray(0, REFERENCE_SIGNATURE_BYTES)
      .toString('base64url');

    return `${signed}.${signature}`;
  }

  private parseToken(
    token: string,
    prefix: 'k' | 'v'
  ): { referenceId: string } | undefined {
    const parts = token.split('.');

    if (
      parts.length !== 3 ||
      parts[0] !== prefix ||
      !/^[A-Za-z0-9_-]{16}$/.test(parts[1] ?? '') ||
      !/^[A-Za-z0-9_-]{16}$/.test(parts[2] ?? '')
    ) {
      return undefined;
    }

    const signed = `${prefix}.${parts[1]}`;
    const supplied = Buffer.from(parts[2]!, 'base64url');
    const expected = createHmac(
      'sha256',
      this.configuration.telegram.callbackSigningKey
    )
      .update(signed)
      .digest()
      .subarray(0, REFERENCE_SIGNATURE_BYTES);

    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      return undefined;
    }

    return { referenceId: `tir_${parts[1]}` };
  }

  private referenceExpiry(): Date {
    return new Date(
      Date.now() + this.configuration.telegram.callbackRefTtlSeconds * 1000
    );
  }

  private toSummary(
    item: {
      displayName: string;
      sku: string | null;
      stockQuantity: { toString(): string } | null;
      stockStatus: string;
      alertClassification: InventoryAlertClassification;
      kind: 'PRODUCT' | 'VARIATION';
    },
    ref: string
  ): TelegramStockItemSummary {
    return {
      ref,
      displayName: item.displayName,
      sku: item.sku,
      quantity: item.stockQuantity?.toString() ?? null,
      stockStatus: item.stockStatus,
      classification: item.alertClassification,
      kind: item.kind,
    };
  }

  private readVariationContext(
    value: Prisma.JsonValue
  ): Array<{ name: string; option: string }> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.flatMap((candidate) => {
      if (candidate === null || typeof candidate !== 'object') {
        return [];
      }

      const record = candidate as Record<string, unknown>;
      return typeof record['name'] === 'string' &&
        typeof record['option'] === 'string'
        ? [{ name: record['name'], option: record['option'] }]
        : [];
    });
  }

  private emptyList(
    state: Exclude<TelegramStockListResult['state'], 'OK'>,
    threshold: number | null
  ): TelegramStockListResult {
    return {
      state,
      items: [],
      nextCursor: null,
      previousCursor: null,
      threshold,
    };
  }
}
