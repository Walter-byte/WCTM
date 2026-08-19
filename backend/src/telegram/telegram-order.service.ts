import { Injectable } from '@nestjs/common';
import {
  MembershipRole,
  Prisma,
  StoreStatus,
  TelegramChatType,
  TelegramCallbackDirection,
  TelegramCallbackPurpose,
} from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { EncryptionService } from '../common/encryption/encryption.service';
import { ApplicationConfigService } from '../config/application-config.service';
import {
  OrderProjectionService,
  type ProjectableStore,
} from '../orders/order-projection.service';
import { mapWooCommerceOrder } from '../orders/order-payload.mapper';
import { PrismaService } from '../prisma/prisma.service';
import {
  type WooCommerceErrorCategory,
  WooCommerceClient,
  WooCommerceClientError,
} from '../woocommerce/client/woocommerce.client';
import type {
  TelegramOrderDetailDto,
  TelegramOrderIdentityDto,
  TelegramOrderListDto,
  TelegramOrderStatusUpdateDto,
  TelegramOrderTransitionsDto,
} from './dto/telegram-internal.dto';

const PAGE_SIZE = 8;
const REACHABLE_ORDER_CAP = 200;
const CALLBACK_ID_BYTES = 12;
const CALLBACK_SIGNATURE_BYTES = 12;
const EMPTY_FRESHNESS_DATE = new Date(0);
const RETRYABLE_WOOCOMMERCE_CATEGORIES = new Set<WooCommerceErrorCategory>([
  'transport',
  'rate-limited',
  'timeout',
]);
const CORE_STATUS_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  pending: ['processing', 'on-hold', 'cancelled'],
  processing: ['on-hold', 'completed', 'cancelled', 'refunded'],
  'on-hold': ['processing', 'completed', 'cancelled', 'refunded'],
  completed: ['processing', 'refunded'],
  cancelled: ['pending'],
  refunded: [],
  failed: ['pending', 'on-hold', 'cancelled'],
};

const ORDER_LIST_SELECT = {
  wcOrderId: true,
  orderNumber: true,
  status: true,
  currency: true,
  totals: true,
  customerSnapshot: true,
  wcCreatedAt: true,
  remoteDeletedAt: true,
  lastSyncedAt: true,
} satisfies Prisma.OrderSelect;

const ORDER_DETAIL_SELECT = {
  wcOrderId: true,
  orderNumber: true,
  status: true,
  currency: true,
  totals: true,
  customerSnapshot: true,
  lineItemsSnapshot: true,
  wcCreatedAt: true,
  wcModifiedAt: true,
  remoteDeletedAt: true,
  lastSyncedAt: true,
} satisfies Prisma.OrderSelect;

const CALLBACK_REFERENCE_SELECT = {
  id: true,
  telegramAccountId: true,
  telegramChatId: true,
  tenantId: true,
  storeId: true,
  purpose: true,
  direction: true,
  boundaryWcCreatedAt: true,
  boundaryWcOrderId: true,
  targetWcOrderId: true,
  reachableOffset: true,
  backReferenceId: true,
  allowedTargetStatuses: true,
  claimedTargetStatus: true,
  expiresAt: true,
} satisfies Prisma.TelegramCallbackReferenceSelect;

type OrderListRecord = Prisma.OrderGetPayload<{
  select: typeof ORDER_LIST_SELECT;
}>;
type OrderDetailRecord = Prisma.OrderGetPayload<{
  select: typeof ORDER_DETAIL_SELECT;
}>;
type CallbackReference = Prisma.TelegramCallbackReferenceGetPayload<{
  select: typeof CALLBACK_REFERENCE_SELECT;
}>;

export interface TelegramOrderFreshness {
  asOf: string;
  delayed: boolean;
}

export interface TelegramOrderSummary {
  ref: string;
  orderNumber: string;
  status: string;
  currency: string;
  total: string;
  customerDisplayName: string;
  wcCreatedAt: string;
  remoteDeleted: boolean;
}

export type TelegramOrderListState =
  'OK' | 'NO_ACTIVE_STORE' | 'UNAUTHORIZED' | 'CONTEXT_CHANGED';

export interface TelegramOrderListResult {
  state: TelegramOrderListState;
  orders: TelegramOrderSummary[];
  nextCursor: string | null;
  previousCursor: string | null;
  freshness: TelegramOrderFreshness;
}

export interface TelegramOrderLineItem {
  name: string;
  quantity: number | string;
  total: string;
}

export interface TelegramOrderDetail {
  orderNumber: string;
  status: string;
  currency: string;
  totals: Readonly<Record<string, string | number>>;
  customerDisplayName: string;
  lineItems: TelegramOrderLineItem[];
  wcCreatedAt: string;
  wcModifiedAt: string;
  remoteDeleted: false;
}

export interface TelegramDeletedOrderMarker {
  orderNumber: string;
  status: string;
  customerDisplayName: string;
  remoteDeleted: true;
}

export type TelegramOrderDetailState =
  | 'OK'
  | 'NOT_FOUND'
  | 'DELETED'
  | 'CONTEXT_CHANGED'
  | 'NO_ACTIVE_STORE'
  | 'UNAUTHORIZED';

export interface TelegramOrderDetailResult {
  state: TelegramOrderDetailState;
  order?: TelegramOrderDetail | TelegramDeletedOrderMarker;
  backCursor?: string;
  transitionsRef?: string;
  freshness: TelegramOrderFreshness;
}

export type TelegramOrderTransitionsState =
  | 'OK'
  | 'NOT_FOUND'
  | 'DELETED'
  | 'NO_ACTIVE_STORE'
  | 'UNAUTHORIZED'
  | 'CONTEXT_CHANGED'
  | 'FORBIDDEN_ROLE';

export interface TelegramOrderTransitionsResult {
  state: TelegramOrderTransitionsState;
  ref?: string;
  currentStatus?: string;
  targets?: string[];
}

export type TelegramOrderStatusUpdateState =
  | 'OK'
  | 'NO_OP'
  | 'RETRYABLE'
  | 'FAILED'
  | 'NOT_FOUND'
  | 'DELETED'
  | 'NO_ACTIVE_STORE'
  | 'UNAUTHORIZED'
  | 'CONTEXT_CHANGED'
  | 'FORBIDDEN_ROLE'
  | 'INVALID_TARGET'
  | 'EXPIRED_REF';

export interface TelegramOrderStatusUpdateResult {
  state: TelegramOrderStatusUpdateState;
  order?: TelegramOrderDetail;
  backCursor?: string;
  freshness?: TelegramOrderFreshness;
}

interface TelegramOrderContext {
  accountId: string;
  userId: string;
  telegramChatId: bigint;
  tenantId: string;
  storeId: string;
  role: MembershipRole;
}

type ContextResolution =
  | { state: 'OK'; context: TelegramOrderContext }
  | { state: 'NO_ACTIVE_STORE' | 'UNAUTHORIZED' };

interface NewReference {
  token: string;
  data: Prisma.TelegramCallbackReferenceCreateManyInput;
}

export interface TelegramOrderNotificationRecipient {
  telegramAccountId: string;
  telegramChatAuthorizationId: string;
  telegramUserId: string;
  telegramChatId: string;
}

export type TelegramPreparedOrderNotification =
  | { state: 'UNAUTHORIZED' | 'NOT_FOUND' | 'DELETED' }
  | {
      state: 'OK';
      orderNumber: string;
      status: string;
      currency: string;
      total: string;
      customerDisplayName: string;
      viewOrderRef: string;
      changeStatusAvailable: boolean;
    };

@Injectable()
export class TelegramOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configuration: ApplicationConfigService,
    private readonly encryption: EncryptionService,
    private readonly orderProjection: OrderProjectionService
  ) {}

  async eligibleNotificationRecipients(
    tenantId: string,
    storeId: string
  ): Promise<TelegramOrderNotificationRecipient[]> {
    const candidates = await this.prisma.telegramChatAuthorization.findMany({
      where: {
        chatType: TelegramChatType.PRIVATE,
        revokedAt: null,
        telegramAccount: {
          deletedAt: null,
          user: {
            memberships: {
              some: {
                tenantId,
                deletedAt: null,
                tenant: { deletedAt: null },
              },
            },
          },
        },
      },
      select: {
        id: true,
        telegramAccountId: true,
        telegramChatId: true,
        telegramAccount: { select: { telegramUserId: true } },
      },
    });
    const recipients: TelegramOrderNotificationRecipient[] = [];

    for (const candidate of candidates) {
      const resolution = await this.resolveContext({
        userId: candidate.telegramAccount.telegramUserId.toString(),
        chatId: candidate.telegramChatId.toString(),
      });

      if (
        resolution.state === 'OK' &&
        resolution.context.accountId === candidate.telegramAccountId &&
        resolution.context.tenantId === tenantId &&
        resolution.context.storeId === storeId
      ) {
        recipients.push({
          telegramAccountId: candidate.telegramAccountId,
          telegramChatAuthorizationId: candidate.id,
          telegramUserId: candidate.telegramAccount.telegramUserId.toString(),
          telegramChatId: candidate.telegramChatId.toString(),
        });
      }
    }

    return recipients;
  }

  async prepareOrderNotification(
    recipient: TelegramOrderNotificationRecipient,
    tenantId: string,
    storeId: string,
    wcOrderId: string
  ): Promise<TelegramPreparedOrderNotification> {
    const resolution = await this.resolveContext({
      userId: recipient.telegramUserId,
      chatId: recipient.telegramChatId,
    });

    if (
      resolution.state !== 'OK' ||
      resolution.context.accountId !== recipient.telegramAccountId ||
      resolution.context.tenantId !== tenantId ||
      resolution.context.storeId !== storeId
    ) {
      return { state: 'UNAUTHORIZED' };
    }

    const context = resolution.context;
    const order = await this.prisma.order.findFirst({
      where: {
        tenantId,
        storeId,
        wcOrderId,
        tenant: { deletedAt: null },
        store: { deletedAt: null, status: StoreStatus.ACTIVE },
      },
      select: ORDER_LIST_SELECT,
    });

    if (!order) {
      return { state: 'NOT_FOUND' };
    }

    if (order.remoteDeletedAt) {
      return { state: 'DELETED' };
    }

    const expiresAt = new Date(
      Date.now() + this.configuration.telegram.callbackRefTtlSeconds * 1000
    );
    const listReference = this.newReference(
      'p',
      context,
      {
        purpose: TelegramCallbackPurpose.LIST_PAGE,
        direction: TelegramCallbackDirection.CURRENT,
        reachableOffset: 0,
      },
      expiresAt
    );
    const detailReference = this.newReference(
      'd',
      context,
      {
        purpose: TelegramCallbackPurpose.ORDER_DETAIL,
        targetWcOrderId: order.wcOrderId,
        backReferenceId: listReference.data.id,
      },
      expiresAt
    );

    await this.prisma.telegramCallbackReference.createMany({
      data: [listReference.data, detailReference.data],
    });

    const summary = this.toSummary(order, detailReference.token);

    return {
      state: 'OK',
      orderNumber: summary.orderNumber,
      status: summary.status,
      currency: summary.currency,
      total: summary.total,
      customerDisplayName: summary.customerDisplayName,
      viewOrderRef: summary.ref,
      changeStatusAvailable:
        context.role !== MembershipRole.MEMBER &&
        (CORE_STATUS_TRANSITIONS[order.status]?.length ?? 0) > 0,
    };
  }

  async list(input: TelegramOrderListDto): Promise<TelegramOrderListResult> {
    const resolution = await this.resolveContext(input.telegram);

    if (resolution.state !== 'OK') {
      return this.emptyList(resolution.state);
    }

    const context = resolution.context;
    let pageReference: CallbackReference | undefined;

    if (input.cursor) {
      pageReference = await this.validateReference(
        input.cursor,
        TelegramCallbackPurpose.LIST_PAGE,
        context
      );

      if (!pageReference) {
        return this.emptyList('CONTEXT_CHANGED');
      }
    }

    const direction =
      pageReference?.direction ?? TelegramCallbackDirection.CURRENT;
    const reachableOffset = pageReference?.reachableOffset ?? 0;

    if (
      reachableOffset < 0 ||
      reachableOffset >= REACHABLE_ORDER_CAP ||
      (direction !== TelegramCallbackDirection.CURRENT &&
        (!pageReference?.boundaryWcCreatedAt ||
          !pageReference.boundaryWcOrderId))
    ) {
      return this.emptyList('CONTEXT_CHANGED');
    }

    const records = await this.queryPage(
      context,
      direction,
      pageReference?.boundaryWcCreatedAt ?? null,
      pageReference?.boundaryWcOrderId ?? null
    );
    const page = records.slice(0, PAGE_SIZE);

    if (direction === TelegramCallbackDirection.PREVIOUS) {
      page.reverse();
    }

    const freshness = this.freshness(
      page.reduce<Date | null>(
        (latest, order) =>
          !latest || order.lastSyncedAt > latest ? order.lastSyncedAt : latest,
        null
      )
    );
    const expiresAt = new Date(
      Date.now() + this.configuration.telegram.callbackRefTtlSeconds * 1000
    );
    const currentReference = this.newReference(
      'p',
      context,
      {
        purpose: TelegramCallbackPurpose.LIST_PAGE,
        direction,
        boundaryWcCreatedAt: pageReference?.boundaryWcCreatedAt ?? undefined,
        boundaryWcOrderId: pageReference?.boundaryWcOrderId ?? undefined,
        reachableOffset,
      },
      expiresAt
    );
    const detailReferences = page.map((order) =>
      this.newReference(
        'd',
        context,
        {
          purpose: TelegramCallbackPurpose.ORDER_DETAIL,
          targetWcOrderId: order.wcOrderId,
          backReferenceId: currentReference.data.id,
        },
        expiresAt
      )
    );
    const first = page[0];
    const last = page.at(-1);
    const hasPrevious = reachableOffset > 0 && Boolean(first);
    const hasNext =
      Boolean(last) &&
      reachableOffset + page.length < REACHABLE_ORDER_CAP &&
      (direction === TelegramCallbackDirection.PREVIOUS ||
        records.length > PAGE_SIZE);
    const previousReference =
      hasPrevious && first
        ? this.newReference(
            'p',
            context,
            {
              purpose: TelegramCallbackPurpose.LIST_PAGE,
              direction: TelegramCallbackDirection.PREVIOUS,
              boundaryWcCreatedAt: first.wcCreatedAt,
              boundaryWcOrderId: first.wcOrderId,
              reachableOffset: Math.max(0, reachableOffset - PAGE_SIZE),
            },
            expiresAt
          )
        : undefined;
    const nextReference =
      hasNext && last
        ? this.newReference(
            'p',
            context,
            {
              purpose: TelegramCallbackPurpose.LIST_PAGE,
              direction: TelegramCallbackDirection.NEXT,
              boundaryWcCreatedAt: last.wcCreatedAt,
              boundaryWcOrderId: last.wcOrderId,
              reachableOffset: reachableOffset + page.length,
            },
            expiresAt
          )
        : undefined;

    await this.prisma.telegramCallbackReference.createMany({
      data: [
        currentReference.data,
        ...detailReferences.map((reference) => reference.data),
        ...(previousReference ? [previousReference.data] : []),
        ...(nextReference ? [nextReference.data] : []),
      ],
    });

    return {
      state: 'OK',
      orders: page.map((order, index) =>
        this.toSummary(order, detailReferences[index]!.token)
      ),
      nextCursor: nextReference?.token ?? null,
      previousCursor: previousReference?.token ?? null,
      freshness,
    };
  }

  async detail(
    input: TelegramOrderDetailDto
  ): Promise<TelegramOrderDetailResult> {
    const resolution = await this.resolveContext(input.telegram);

    if (resolution.state !== 'OK') {
      return this.emptyDetail(resolution.state);
    }

    const context = resolution.context;
    const reference = await this.validateReference(
      input.ref,
      TelegramCallbackPurpose.ORDER_DETAIL,
      context
    );

    if (!reference?.targetWcOrderId || !reference.backReferenceId) {
      return this.emptyDetail('CONTEXT_CHANGED');
    }

    const order = await this.prisma.order.findFirst({
      where: {
        tenantId: context.tenantId,
        storeId: context.storeId,
        wcOrderId: reference.targetWcOrderId,
        tenant: { deletedAt: null },
        store: {
          deletedAt: null,
          status: StoreStatus.ACTIVE,
        },
      },
      select: ORDER_DETAIL_SELECT,
    });
    const backCursor = this.tokenForReferenceId('p', reference.backReferenceId);

    if (!order) {
      return {
        state: 'NOT_FOUND',
        backCursor,
        freshness: this.freshness(null),
      };
    }

    const freshness = this.freshness(order.lastSyncedAt);

    if (order.remoteDeletedAt) {
      return {
        state: 'DELETED',
        order: {
          orderNumber: order.orderNumber,
          status: order.status,
          customerDisplayName: customerDisplayName(order.customerSnapshot),
          remoteDeleted: true,
        },
        backCursor,
        freshness,
      };
    }

    return {
      state: 'OK',
      order: this.toDetail(order),
      backCursor,
      ...(context.role !== MembershipRole.MEMBER &&
      (CORE_STATUS_TRANSITIONS[order.status]?.length ?? 0) > 0
        ? { transitionsRef: input.ref }
        : {}),
      freshness,
    };
  }

  async transitions(
    input: TelegramOrderTransitionsDto
  ): Promise<TelegramOrderTransitionsResult> {
    const resolution = await this.resolveContext(input.telegram);

    if (resolution.state !== 'OK') {
      return { state: resolution.state };
    }

    const context = resolution.context;
    const reference = await this.validateReference(
      input.ref,
      TelegramCallbackPurpose.ORDER_DETAIL,
      context
    );

    if (!reference?.targetWcOrderId || !reference.backReferenceId) {
      return { state: 'CONTEXT_CHANGED' };
    }

    if (context.role === MembershipRole.MEMBER) {
      return { state: 'FORBIDDEN_ROLE' };
    }

    const order = await this.prisma.order.findFirst({
      where: {
        tenantId: context.tenantId,
        storeId: context.storeId,
        wcOrderId: reference.targetWcOrderId,
        tenant: { deletedAt: null },
        store: { deletedAt: null, status: StoreStatus.ACTIVE },
      },
      select: { status: true, remoteDeletedAt: true },
    });

    if (!order) {
      return { state: 'NOT_FOUND' };
    }

    if (order.remoteDeletedAt) {
      return { state: 'DELETED' };
    }

    const targets = [...(CORE_STATUS_TRANSITIONS[order.status] ?? [])];
    const writeReference = this.newReference(
      's',
      context,
      {
        purpose: TelegramCallbackPurpose.STATUS_WRITE,
        targetWcOrderId: reference.targetWcOrderId,
        backReferenceId: reference.backReferenceId,
        allowedTargetStatuses: targets,
      },
      new Date(
        Date.now() + this.configuration.telegram.callbackRefTtlSeconds * 1000
      )
    );

    await this.prisma.telegramCallbackReference.create({
      data: writeReference.data,
      select: { id: true },
    });

    return {
      state: 'OK',
      ref: writeReference.token,
      currentStatus: order.status,
      targets,
    };
  }

  async updateStatus(
    input: TelegramOrderStatusUpdateDto
  ): Promise<TelegramOrderStatusUpdateResult> {
    const resolution = await this.resolveContext(input.telegram);

    if (resolution.state !== 'OK') {
      return { state: resolution.state };
    }

    const context = resolution.context;

    if (context.role === MembershipRole.MEMBER) {
      return { state: 'FORBIDDEN_ROLE' };
    }

    const parsed = this.parseAndVerifyToken(input.ref, 's');

    if (!parsed) {
      return { state: 'CONTEXT_CHANGED' };
    }

    const reference = await this.prisma.telegramCallbackReference.findUnique({
      where: { id: parsed.referenceId },
      select: CALLBACK_REFERENCE_SELECT,
    });

    if (
      !reference ||
      reference.purpose !== TelegramCallbackPurpose.STATUS_WRITE
    ) {
      return { state: 'CONTEXT_CHANGED' };
    }

    if (reference.expiresAt <= new Date()) {
      return this.referenceStatusDetail('EXPIRED_REF', reference, context);
    }

    if (!this.referenceMatchesContext(reference, context)) {
      return { state: 'CONTEXT_CHANGED' };
    }

    if (
      !reference.targetWcOrderId ||
      !reference.backReferenceId ||
      !reference.allowedTargetStatuses.includes(input.target)
    ) {
      return { state: 'INVALID_TARGET' };
    }

    const order = await this.prisma.order.findFirst({
      where: {
        tenantId: context.tenantId,
        storeId: context.storeId,
        wcOrderId: reference.targetWcOrderId,
        tenant: { deletedAt: null },
        store: { deletedAt: null, status: StoreStatus.ACTIVE },
      },
      select: { remoteDeletedAt: true },
    });

    if (!order) {
      return { state: 'NOT_FOUND' };
    }

    if (order.remoteDeletedAt) {
      return { state: 'DELETED' };
    }

    const store = await this.loadWritableStore(context);

    if (!store) {
      return { state: 'NO_ACTIVE_STORE' };
    }

    const existing = await this.prisma.telegramOrderStatusWrite.findUnique({
      where: {
        callbackReferenceId_targetStatus: {
          callbackReferenceId: reference.id,
          targetStatus: input.target,
        },
      },
      select: { id: true, result: true },
    });

    if (existing?.result) {
      return existing.result as unknown as TelegramOrderStatusUpdateResult;
    }

    if (existing) {
      return { state: 'RETRYABLE' };
    }

    let livePayload: unknown;

    try {
      livePayload = await this.createWooCommerceClient(store).fetchOrder(
        reference.targetWcOrderId
      );
      await this.orderProjection.reconcileAuthoritativeOrder(
        store,
        livePayload,
        reference.targetWcOrderId
      );
    } catch (error: unknown) {
      return { state: this.failureState(error) };
    }

    const liveStatus = this.readMappedStatus(
      livePayload,
      reference.targetWcOrderId
    );

    if (!liveStatus) {
      return { state: 'FAILED' };
    }

    if (
      liveStatus !== input.target &&
      !(CORE_STATUS_TRANSITIONS[liveStatus] ?? []).includes(input.target)
    ) {
      return { state: 'INVALID_TARGET' };
    }

    const claim = await this.prisma.telegramCallbackReference.updateMany({
      where: {
        id: reference.id,
        OR: [
          { claimedTargetStatus: null },
          { claimedTargetStatus: input.target },
        ],
      },
      data: { claimedTargetStatus: input.target },
    });

    if (claim.count !== 1) {
      return { state: 'INVALID_TARGET' };
    }

    let writeId: string;

    try {
      const write = await this.prisma.telegramOrderStatusWrite.create({
        data: {
          id: `tosw_${randomBytes(16).toString('hex')}`,
          callbackReferenceId: reference.id,
          telegramAccountId: context.accountId,
          tenantId: context.tenantId,
          storeId: context.storeId,
          wcOrderId: reference.targetWcOrderId,
          targetStatus: input.target,
        },
        select: { id: true },
      });
      writeId = write.id;
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const concurrent = await this.prisma.telegramOrderStatusWrite.findUnique({
        where: {
          callbackReferenceId_targetStatus: {
            callbackReferenceId: reference.id,
            targetStatus: input.target,
          },
        },
        select: { result: true },
      });

      return concurrent?.result
        ? (concurrent.result as unknown as TelegramOrderStatusUpdateResult)
        : { state: 'RETRYABLE' };
    }

    if (liveStatus === input.target) {
      return this.completeStatusWrite(
        writeId,
        'NO_OP',
        context,
        reference.targetWcOrderId,
        input.target,
        reference.backReferenceId
      );
    }

    try {
      const updatedPayload = await this.createWooCommerceClient(
        store
      ).updateOrderStatus(reference.targetWcOrderId, input.target);
      const updatedStatus = this.readMappedStatus(
        updatedPayload,
        reference.targetWcOrderId
      );

      await this.orderProjection.reconcileAuthoritativeOrder(
        store,
        updatedPayload,
        reference.targetWcOrderId
      );

      if (updatedStatus !== input.target) {
        return this.completeFailure(writeId, 'FAILED');
      }

      return this.completeStatusWrite(
        writeId,
        'OK',
        context,
        reference.targetWcOrderId,
        input.target,
        reference.backReferenceId
      );
    } catch (error: unknown) {
      return this.reconcileLostWrite(
        writeId,
        error,
        context,
        store,
        reference.targetWcOrderId,
        input.target,
        reference.backReferenceId
      );
    }
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
            revokedAt: null,
          },
          select: {
            telegramAccountId: true,
            telegramChatId: true,
          },
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
        role: {
          in: [
            MembershipRole.OWNER,
            MembershipRole.ADMIN,
            MembershipRole.MEMBER,
          ],
        },
      },
      select: {
        tenantId: true,
        role: true,
      },
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
        userId: account.userId,
        telegramChatId,
        tenantId: membership.tenantId,
        storeId: stores[0]!.id,
        role: membership.role,
      },
    };
  }

  private loadWritableStore(
    context: TelegramOrderContext
  ): Promise<ProjectableStore | null> {
    return this.prisma.store.findFirst({
      where: {
        id: context.storeId,
        tenantId: context.tenantId,
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
      },
    });
  }

  private createWooCommerceClient(store: ProjectableStore): WooCommerceClient {
    return new WooCommerceClient({
      storeUrl: store.baseUrl,
      consumerKey: this.encryption.decrypt(store.consumerKeyEncrypted),
      consumerSecret: this.encryption.decrypt(store.consumerSecretEncrypted),
      resilience: this.configuration.woocommerce.rest,
    });
  }

  private readMappedStatus(
    payload: unknown,
    expectedWcOrderId: string
  ): string | undefined {
    try {
      const mapped = mapWooCommerceOrder(payload);

      return mapped.wcOrderId === expectedWcOrderId ? mapped.status : undefined;
    } catch {
      return undefined;
    }
  }

  private failureState(error: unknown): 'RETRYABLE' | 'FAILED' | 'NOT_FOUND' {
    if (error instanceof WooCommerceClientError) {
      if (error.category === 'not-found') {
        return 'NOT_FOUND';
      }

      return RETRYABLE_WOOCOMMERCE_CATEGORIES.has(error.category)
        ? 'RETRYABLE'
        : 'FAILED';
    }

    return 'FAILED';
  }

  private async reconcileLostWrite(
    writeId: string,
    writeError: unknown,
    context: TelegramOrderContext,
    store: ProjectableStore,
    wcOrderId: string,
    target: string,
    backReferenceId: string
  ): Promise<TelegramOrderStatusUpdateResult> {
    try {
      const livePayload =
        await this.createWooCommerceClient(store).fetchOrder(wcOrderId);
      await this.orderProjection.reconcileAuthoritativeOrder(
        store,
        livePayload,
        wcOrderId
      );

      if (this.readMappedStatus(livePayload, wcOrderId) === target) {
        return this.completeStatusWrite(
          writeId,
          'OK',
          context,
          wcOrderId,
          target,
          backReferenceId
        );
      }

      return this.completeFailure(writeId, this.failureState(writeError));
    } catch (reconciliationError: unknown) {
      return this.completeFailure(
        writeId,
        this.failureState(reconciliationError)
      );
    }
  }

  private async completeStatusWrite(
    writeId: string,
    state: 'OK' | 'NO_OP',
    context: TelegramOrderContext,
    wcOrderId: string,
    target: string,
    backReferenceId: string
  ): Promise<TelegramOrderStatusUpdateResult> {
    const order = await this.prisma.order.findFirst({
      where: {
        tenantId: context.tenantId,
        storeId: context.storeId,
        wcOrderId,
        tenant: { deletedAt: null },
        store: { deletedAt: null, status: StoreStatus.ACTIVE },
      },
      select: ORDER_DETAIL_SELECT,
    });

    if (!order || order.remoteDeletedAt) {
      return this.completeFailure(writeId, !order ? 'NOT_FOUND' : 'DELETED');
    }

    const result: TelegramOrderStatusUpdateResult = {
      state,
      order: this.toDetail(order),
      backCursor: this.tokenForReferenceId('p', backReferenceId),
      freshness: this.freshness(order.lastSyncedAt),
    };
    const completedAt = new Date();

    await this.prisma.$transaction([
      this.prisma.telegramOrderStatusWrite.update({
        where: { id: writeId },
        data: {
          outcome: state,
          result: result as unknown as Prisma.InputJsonObject,
          completedAt,
        },
        select: { id: true },
      }),
      ...(state === 'OK'
        ? [
            this.prisma.auditLog.create({
              data: {
                id: `aud_${randomBytes(16).toString('hex')}`,
                tenantId: context.tenantId,
                userId: context.userId,
                action: 'telegram.order.status.updated',
                entityType: 'Order',
                entityId: wcOrderId,
                metadata: {
                  storeId: context.storeId,
                  targetStatus: target,
                },
              },
              select: { id: true },
            }),
          ]
        : []),
    ]);

    return result;
  }

  private async referenceStatusDetail(
    state: 'EXPIRED_REF',
    reference: CallbackReference,
    context: TelegramOrderContext
  ): Promise<TelegramOrderStatusUpdateResult> {
    if (!reference.targetWcOrderId || !reference.backReferenceId) {
      return { state };
    }

    const order = await this.prisma.order.findFirst({
      where: {
        tenantId: context.tenantId,
        storeId: context.storeId,
        wcOrderId: reference.targetWcOrderId,
        tenant: { deletedAt: null },
        store: { deletedAt: null, status: StoreStatus.ACTIVE },
      },
      select: ORDER_DETAIL_SELECT,
    });

    if (!order || order.remoteDeletedAt) {
      return { state };
    }

    return {
      state,
      order: this.toDetail(order),
      backCursor: this.tokenForReferenceId('p', reference.backReferenceId),
      freshness: this.freshness(order.lastSyncedAt),
    };
  }

  private async completeFailure(
    writeId: string,
    state: Exclude<
      TelegramOrderStatusUpdateState,
      'OK' | 'NO_OP' | 'UNAUTHORIZED' | 'NO_ACTIVE_STORE' | 'CONTEXT_CHANGED'
    >
  ): Promise<TelegramOrderStatusUpdateResult> {
    const result: TelegramOrderStatusUpdateResult = { state };

    await this.prisma.telegramOrderStatusWrite.update({
      where: { id: writeId },
      data: {
        outcome: state,
        result: result as unknown as Prisma.InputJsonObject,
        completedAt: new Date(),
      },
      select: { id: true },
    });

    return result;
  }

  private queryPage(
    context: TelegramOrderContext,
    direction: TelegramCallbackDirection,
    boundaryWcCreatedAt: Date | null,
    boundaryWcOrderId: string | null
  ): Promise<OrderListRecord[]> {
    const movingPrevious = direction === TelegramCallbackDirection.PREVIOUS;
    const boundary =
      boundaryWcCreatedAt && boundaryWcOrderId
        ? {
            OR: [
              {
                wcCreatedAt: movingPrevious
                  ? { gt: boundaryWcCreatedAt }
                  : { lt: boundaryWcCreatedAt },
              },
              {
                wcCreatedAt: boundaryWcCreatedAt,
                wcOrderId: movingPrevious
                  ? { gt: boundaryWcOrderId }
                  : { lt: boundaryWcOrderId },
              },
            ],
          }
        : {};

    return this.prisma.order.findMany({
      where: {
        tenantId: context.tenantId,
        storeId: context.storeId,
        tenant: { deletedAt: null },
        store: {
          deletedAt: null,
          status: StoreStatus.ACTIVE,
        },
        ...boundary,
      },
      select: ORDER_LIST_SELECT,
      orderBy: [
        { wcCreatedAt: movingPrevious ? 'asc' : 'desc' },
        { wcOrderId: movingPrevious ? 'asc' : 'desc' },
      ],
      take: PAGE_SIZE + 1,
    });
  }

  private async validateReference(
    token: string,
    purpose: TelegramCallbackPurpose,
    context: TelegramOrderContext
  ): Promise<CallbackReference | undefined> {
    const prefix = purpose === TelegramCallbackPurpose.LIST_PAGE ? 'p' : 'd';
    const parsed = this.parseAndVerifyToken(token, prefix);

    if (!parsed) {
      return undefined;
    }

    const reference = await this.prisma.telegramCallbackReference.findUnique({
      where: { id: parsed.referenceId },
      select: CALLBACK_REFERENCE_SELECT,
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

  private referenceMatchesContext(
    reference: CallbackReference,
    context: TelegramOrderContext
  ): boolean {
    return (
      reference.telegramAccountId === context.accountId &&
      reference.telegramChatId === context.telegramChatId &&
      reference.tenantId === context.tenantId &&
      reference.storeId === context.storeId
    );
  }

  private newReference(
    prefix: 'p' | 'd' | 's',
    context: TelegramOrderContext,
    values: Pick<
      Prisma.TelegramCallbackReferenceCreateManyInput,
      | 'purpose'
      | 'direction'
      | 'boundaryWcCreatedAt'
      | 'boundaryWcOrderId'
      | 'targetWcOrderId'
      | 'reachableOffset'
      | 'backReferenceId'
      | 'allowedTargetStatuses'
    >,
    expiresAt: Date
  ): NewReference {
    const shortId = randomBytes(CALLBACK_ID_BYTES).toString('base64url');
    const id = `tcr_${shortId}`;

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
      },
    };
  }

  private tokenForReferenceId(
    prefix: 'p' | 'd' | 's',
    referenceId: string
  ): string {
    const shortId = referenceId.replace(/^tcr_/, '');
    const signedValue = `${prefix}.${shortId}`;
    const signature = createHmac(
      'sha256',
      this.configuration.telegram.callbackSigningKey
    )
      .update(signedValue)
      .digest()
      .subarray(0, CALLBACK_SIGNATURE_BYTES)
      .toString('base64url');

    return `${signedValue}.${signature}`;
  }

  private parseAndVerifyToken(
    token: string,
    expectedPrefix: 'p' | 'd' | 's'
  ): { referenceId: string } | undefined {
    const parts = token.split('.');

    if (
      parts.length !== 3 ||
      parts[0] !== expectedPrefix ||
      !/^[A-Za-z0-9_-]{16}$/.test(parts[1] ?? '') ||
      !/^[A-Za-z0-9_-]{16}$/.test(parts[2] ?? '')
    ) {
      return undefined;
    }

    const signedValue = `${parts[0]}.${parts[1]}`;
    const supplied = Buffer.from(parts[2]!, 'base64url');
    const expected = createHmac(
      'sha256',
      this.configuration.telegram.callbackSigningKey
    )
      .update(signedValue)
      .digest()
      .subarray(0, CALLBACK_SIGNATURE_BYTES);

    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      return undefined;
    }

    return { referenceId: `tcr_${parts[1]}` };
  }

  private toSummary(order: OrderListRecord, ref: string): TelegramOrderSummary {
    return {
      ref,
      orderNumber: order.orderNumber,
      status: order.status,
      currency: order.currency,
      total: totalValue(order.totals),
      customerDisplayName: customerDisplayName(order.customerSnapshot),
      wcCreatedAt: order.wcCreatedAt.toISOString(),
      remoteDeleted: order.remoteDeletedAt !== null,
    };
  }

  private toDetail(order: OrderDetailRecord): TelegramOrderDetail {
    return {
      orderNumber: order.orderNumber,
      status: order.status,
      currency: order.currency,
      totals: safeTotals(order.totals),
      customerDisplayName: customerDisplayName(order.customerSnapshot),
      lineItems: safeLineItems(order.lineItemsSnapshot),
      wcCreatedAt: order.wcCreatedAt.toISOString(),
      wcModifiedAt: order.wcModifiedAt.toISOString(),
      remoteDeleted: false,
    };
  }

  private freshness(asOf: Date | null): TelegramOrderFreshness {
    const effectiveAsOf = asOf ?? EMPTY_FRESHNESS_DATE;

    return {
      asOf: effectiveAsOf.toISOString(),
      delayed:
        asOf === null ||
        Date.now() - effectiveAsOf.getTime() >
          this.configuration.telegram.orderFreshnessThresholdSeconds * 1000,
    };
  }

  private emptyList(
    state: Exclude<TelegramOrderListState, 'OK'>
  ): TelegramOrderListResult {
    return {
      state,
      orders: [],
      nextCursor: null,
      previousCursor: null,
      freshness: this.freshness(null),
    };
  }

  private emptyDetail(
    state: Exclude<TelegramOrderDetailState, 'OK' | 'DELETED'>
  ): TelegramOrderDetailResult {
    return {
      state,
      freshness: this.freshness(null),
    };
  }
}

function totalValue(value: Prisma.JsonValue): string {
  const total = jsonRecord(value)?.['total'];

  return typeof total === 'string' || typeof total === 'number'
    ? String(total)
    : '—';
}

function customerDisplayName(value: Prisma.JsonValue): string {
  const billing = jsonRecord(jsonRecord(value)?.['billing']);
  const firstName =
    typeof billing?.['first_name'] === 'string'
      ? billing['first_name'].trim()
      : '';
  const lastName =
    typeof billing?.['last_name'] === 'string'
      ? billing['last_name'].trim()
      : '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ');

  if (fullName) {
    return fullName;
  }

  const company =
    typeof billing?.['company'] === 'string' ? billing['company'].trim() : '';

  return company || 'Guest';
}

function safeTotals(
  value: Prisma.JsonValue
): Readonly<Record<string, string | number>> {
  const totals = jsonRecord(value);

  if (!totals) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(totals).filter(
      (entry): entry is [string, string | number] =>
        typeof entry[1] === 'string' || typeof entry[1] === 'number'
    )
  );
}

function safeLineItems(value: Prisma.JsonValue): TelegramOrderLineItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const record = jsonRecord(item);
    const name = record?.['name'];
    const quantity = record?.['quantity'];
    const total = record?.['total'];

    if (
      typeof name !== 'string' ||
      (typeof quantity !== 'string' && typeof quantity !== 'number') ||
      (typeof total !== 'string' && typeof total !== 'number')
    ) {
      return [];
    }

    return [{ name, quantity, total: String(total) }];
  });
}

function jsonRecord(
  value: Prisma.JsonValue | undefined
): Record<string, Prisma.JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : undefined;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'P2002'
  );
}
