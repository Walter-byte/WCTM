import { Injectable } from '@nestjs/common';
import {
  MembershipRole,
  NotificationCategory,
  NotificationRecipientMode,
  Prisma,
  StoreStatus,
  TelegramChatType,
  TelegramCallbackDirection,
  TelegramCallbackPurpose,
  TelegramOrderNoteActionState,
  TelegramOrderNoteVisibility,
} from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { EncryptionService } from '../common/encryption/encryption.service';
import { ApplicationConfigService } from '../config/application-config.service';
import {
  EntitlementInactiveException,
  EntitlementService,
} from '../entitlements/entitlement.service';
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
import {
  TELEGRAM_ORDER_NOTE_MAX_LENGTH,
  type TelegramOrderDetailDto,
  type TelegramOrderIdentityDto,
  type TelegramOrderListDto,
  type TelegramOrderLookupDto,
  type TelegramOrderNotePrepareDto,
  type TelegramOrderNoteStartDto,
  type TelegramOrderStatusUpdateDto,
  type TelegramOrderTransitionsDto,
} from './dto/telegram-internal.dto';

const PAGE_SIZE = 8;
const REACHABLE_ORDER_CAP = 200;
const CALLBACK_ID_BYTES = 12;
const CALLBACK_SIGNATURE_BYTES = 12;
const ORDER_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
const NOTE_IN_FLIGHT_AMBIGUITY_MS = 60_000;
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
  paymentSnapshot: true,
  shippingLinesSnapshot: true,
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
  noteVisibility: true,
  noteBodyEncrypted: true,
  noteContentFingerprint: true,
  noteClaimedAt: true,
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
  payment: {
    method: string | null;
    paid: boolean;
  };
  shipping: {
    methods: string[];
    addressLines: string[];
  };
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
  refreshRef?: string;
  addNoteRef?: string;
  freshness: TelegramOrderFreshness;
}

export type TelegramOrderLookupState =
  TelegramOrderDetailState | 'MALFORMED_ORDER_NUMBER' | 'AMBIGUOUS';

export interface TelegramOrderLookupResult extends Omit<
  TelegramOrderDetailResult,
  'state'
> {
  state: TelegramOrderLookupState;
}

export type TelegramOrderRefreshState =
  TelegramOrderDetailState | 'RETRYABLE' | 'FAILED';

export interface TelegramOrderRefreshResult extends Omit<
  TelegramOrderDetailResult,
  'state'
> {
  state: TelegramOrderRefreshState;
}

export type TelegramOrderNoteState =
  | 'OK'
  | 'CANCELLED'
  | 'INVALID_NOTE'
  | 'IN_PROGRESS'
  | 'AMBIGUOUS'
  | 'RETRYABLE'
  | 'FAILED'
  | 'NOT_FOUND'
  | 'DELETED'
  | 'NO_ACTIVE_STORE'
  | 'UNAUTHORIZED'
  | 'CONTEXT_CHANGED'
  | 'FORBIDDEN_ROLE'
  | 'EXPIRED_REF';

export interface TelegramOrderNoteOptionsResult {
  state: TelegramOrderNoteState;
  ref?: string;
  visibilities?: TelegramOrderNoteVisibility[];
}

export interface TelegramOrderNoteStartResult {
  state: TelegramOrderNoteState;
  inputRef?: string;
  detailRef?: string;
  visibility?: TelegramOrderNoteVisibility;
  maxLength?: number;
}

export interface TelegramOrderNotePrepareResult {
  state: TelegramOrderNoteState;
  confirmRef?: string;
  detailRef?: string;
  visibility?: TelegramOrderNoteVisibility;
  preview?: string;
}

export interface TelegramOrderNoteMutationResult {
  state: TelegramOrderNoteState;
  detailRef?: string;
  visibility?: TelegramOrderNoteVisibility;
  orderNumber?: string;
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
  membershipId: string;
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
  membershipId?: string;
  telegramAccountId: string;
  telegramChatAuthorizationId: string;
  telegramUserId: string;
  telegramChatId: string;
}

export type TelegramPreparedOrderNotification =
  | { state: 'UNAUTHORIZED' | 'NOT_FOUND' | 'DELETED' | 'DISABLED' }
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
    private readonly orderProjection: OrderProjectionService,
    private readonly entitlements: EntitlementService
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
          membershipId: resolution.context.membershipId,
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
      (recipient.membershipId !== undefined &&
        resolution.context.membershipId !== recipient.membershipId) ||
      resolution.context.tenantId !== tenantId ||
      resolution.context.storeId !== storeId
    ) {
      return { state: 'UNAUTHORIZED' };
    }

    const context = resolution.context;
    await this.entitlements.assertActive(context.tenantId);
    const policy = await this.prisma.store.findFirst({
      where: {
        id: storeId,
        tenantId,
        deletedAt: null,
        status: StoreStatus.ACTIVE,
        tenant: { deletedAt: null },
      },
      select: {
        enabledNotificationCategories: true,
        notificationRecipientMode: true,
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
        NotificationCategory.ORDER_CREATED
      ) ||
      (policy.notificationRecipientMode ===
        NotificationRecipientMode.SELECTED &&
        policy.selectedNotificationRecipients.length === 0)
    ) {
      return { state: 'DISABLED' };
    }

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

    await this.entitlements.assertActive(context.tenantId);

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

  async lookup(
    input: TelegramOrderLookupDto
  ): Promise<TelegramOrderLookupResult> {
    const resolution = await this.resolveContext(input.telegram);

    if (resolution.state !== 'OK') {
      return this.emptyDetail(resolution.state);
    }

    const context = resolution.context;
    await this.entitlements.assertActive(context.tenantId);

    if (!ORDER_NUMBER_PATTERN.test(input.orderNumber)) {
      return {
        state: 'MALFORMED_ORDER_NUMBER',
        freshness: this.freshness(null),
      };
    }

    const matches = await this.prisma.order.findMany({
      where: {
        tenantId: context.tenantId,
        storeId: context.storeId,
        orderNumber: input.orderNumber,
        tenant: { deletedAt: null },
        store: { deletedAt: null, status: StoreStatus.ACTIVE },
      },
      select: { wcOrderId: true },
      take: 2,
    });

    if (matches.length === 0) {
      return { state: 'NOT_FOUND', freshness: this.freshness(null) };
    }

    if (matches.length !== 1) {
      return { state: 'AMBIGUOUS', freshness: this.freshness(null) };
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
        targetWcOrderId: matches[0]!.wcOrderId,
        backReferenceId: listReference.data.id,
      },
      expiresAt
    );

    await this.prisma.telegramCallbackReference.createMany({
      data: [listReference.data, detailReference.data],
    });

    return this.detail({
      telegram: input.telegram,
      ref: detailReference.token,
    });
  }

  async openProjectedDetail(input: {
    telegram: TelegramOrderIdentityDto;
    wcOrderId: string;
  }): Promise<TelegramOrderDetailResult> {
    const resolution = await this.resolveContext(input.telegram);

    if (resolution.state !== 'OK') {
      return this.emptyDetail(resolution.state);
    }

    const context = resolution.context;
    await this.entitlements.assertActive(context.tenantId);
    const order = await this.prisma.order.findFirst({
      where: {
        tenantId: context.tenantId,
        storeId: context.storeId,
        wcOrderId: input.wcOrderId,
        remoteDeletedAt: null,
        tenant: { deletedAt: null },
        store: { deletedAt: null, status: StoreStatus.ACTIVE },
      },
      select: { wcOrderId: true },
    });

    if (!order) {
      return this.emptyDetail('NOT_FOUND');
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

    return this.detail({
      telegram: input.telegram,
      ref: detailReference.token,
    });
  }

  async refresh(
    input: TelegramOrderDetailDto
  ): Promise<TelegramOrderRefreshResult> {
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

    await this.entitlements.assertActive(context.tenantId);

    const order = await this.prisma.order.findFirst({
      where: {
        tenantId: context.tenantId,
        storeId: context.storeId,
        wcOrderId: reference.targetWcOrderId,
        tenant: { deletedAt: null },
        store: { deletedAt: null, status: StoreStatus.ACTIVE },
      },
      select: { remoteDeletedAt: true, lastSyncedAt: true },
    });

    if (!order) {
      return { state: 'NOT_FOUND', freshness: this.freshness(null) };
    }

    if (order.remoteDeletedAt) {
      return this.detail(input);
    }

    const store = await this.loadWritableStore(context);

    if (!store) {
      return this.emptyDetail('NO_ACTIVE_STORE');
    }

    try {
      await this.entitlements.assertActive(context.tenantId);
      const payload = await this.createWooCommerceClient(store).fetchOrder(
        reference.targetWcOrderId
      );
      await this.orderProjection.reconcileAuthoritativeOrder(
        store,
        payload,
        reference.targetWcOrderId
      );
    } catch (error: unknown) {
      return {
        state: this.failureState(error),
        backCursor: this.tokenForReferenceId('p', reference.backReferenceId),
        freshness: this.freshness(order.lastSyncedAt),
      };
    }

    return this.detail(input);
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

    await this.entitlements.assertActive(context.tenantId);

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
      refreshRef: input.ref,
      ...(context.role !== MembershipRole.MEMBER &&
      (CORE_STATUS_TRANSITIONS[order.status]?.length ?? 0) > 0
        ? { transitionsRef: input.ref }
        : {}),
      ...(context.role !== MembershipRole.MEMBER
        ? { addNoteRef: input.ref }
        : {}),
      freshness,
    };
  }

  async noteOptions(
    input: TelegramOrderDetailDto
  ): Promise<TelegramOrderNoteOptionsResult> {
    const resolved = await this.resolveNoteDetailReference(input);

    if (resolved.state !== 'OK') {
      return { state: resolved.state };
    }

    await this.entitlements.assertActive(resolved.context.tenantId);

    return {
      state: 'OK',
      ref: input.ref,
      visibilities: [
        TelegramOrderNoteVisibility.INTERNAL,
        TelegramOrderNoteVisibility.CUSTOMER,
      ],
    };
  }

  async startNote(
    input: TelegramOrderNoteStartDto
  ): Promise<TelegramOrderNoteStartResult> {
    const resolved = await this.resolveNoteDetailReference(input);

    if (resolved.state !== 'OK') {
      return { state: resolved.state };
    }

    await this.entitlements.assertActive(resolved.context.tenantId);

    const visibility = input.visibility as TelegramOrderNoteVisibility;
    const inputReference = this.newReference(
      'i',
      resolved.context,
      {
        purpose: TelegramCallbackPurpose.NOTE_INPUT,
        targetWcOrderId: resolved.reference.targetWcOrderId,
        backReferenceId: resolved.reference.id,
        noteVisibility: visibility,
      },
      new Date(
        Date.now() + this.configuration.telegram.callbackRefTtlSeconds * 1000
      )
    );

    await this.prisma.telegramCallbackReference.create({
      data: inputReference.data,
      select: { id: true },
    });

    return {
      state: 'OK',
      inputRef: inputReference.token,
      detailRef: input.ref,
      visibility,
      maxLength: TELEGRAM_ORDER_NOTE_MAX_LENGTH,
    };
  }

  async prepareNote(
    input: TelegramOrderNotePrepareDto
  ): Promise<TelegramOrderNotePrepareResult> {
    const resolution = await this.resolveContext(input.telegram);

    if (resolution.state !== 'OK') {
      return { state: resolution.state };
    }

    const context = resolution.context;

    if (context.role === MembershipRole.MEMBER) {
      return { state: 'FORBIDDEN_ROLE' };
    }

    await this.clearExpiredNoteBodies(context);

    const parsed = this.parseAndVerifyToken(input.ref, 'i');

    if (!parsed) {
      return { state: 'CONTEXT_CHANGED' };
    }

    const reference = await this.prisma.telegramCallbackReference.findUnique({
      where: { id: parsed.referenceId },
      select: CALLBACK_REFERENCE_SELECT,
    });

    if (!reference || !this.referenceMatchesContext(reference, context)) {
      return { state: 'CONTEXT_CHANGED' };
    }

    if (reference.expiresAt <= new Date()) {
      return { state: 'EXPIRED_REF' };
    }

    if (
      !reference.targetWcOrderId ||
      !reference.backReferenceId ||
      !reference.noteVisibility
    ) {
      return { state: 'CONTEXT_CHANGED' };
    }

    await this.entitlements.assertActive(context.tenantId);

    const note = normalizeOrderNote(input.note);

    if (!note) {
      return {
        state: 'INVALID_NOTE',
        detailRef: this.tokenForReferenceId('d', reference.backReferenceId),
      };
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

    const fingerprint = this.noteFingerprint(note);
    const encrypted = this.encryption.encrypt(note);
    const updated = await this.prisma.telegramCallbackReference.updateMany({
      where: {
        id: reference.id,
        purpose: TelegramCallbackPurpose.NOTE_INPUT,
        expiresAt: { gt: new Date() },
      },
      data: {
        purpose: TelegramCallbackPurpose.NOTE_CONFIRM,
        noteBodyEncrypted: encrypted,
        noteContentFingerprint: fingerprint,
      },
    });

    if (updated.count !== 1) {
      const current = await this.prisma.telegramCallbackReference.findUnique({
        where: { id: reference.id },
        select: CALLBACK_REFERENCE_SELECT,
      });

      if (
        !current ||
        current.purpose !== TelegramCallbackPurpose.NOTE_CONFIRM ||
        current.noteContentFingerprint !== fingerprint ||
        !this.referenceMatchesContext(current, context)
      ) {
        return { state: 'CONTEXT_CHANGED' };
      }
    }

    return {
      state: 'OK',
      confirmRef: this.tokenForReferenceId('c', reference.id),
      detailRef: this.tokenForReferenceId('d', reference.backReferenceId),
      visibility: reference.noteVisibility,
      preview: notePreview(note),
    };
  }

  async cancelNote(
    input: TelegramOrderDetailDto
  ): Promise<TelegramOrderNoteMutationResult> {
    const resolution = await this.resolveContext(input.telegram);

    if (resolution.state !== 'OK') {
      return { state: resolution.state };
    }

    if (resolution.context.role === MembershipRole.MEMBER) {
      return { state: 'FORBIDDEN_ROLE' };
    }

    await this.clearExpiredNoteBodies(resolution.context);

    const prefix = input.ref.startsWith('i.') ? 'i' : 'c';
    const parsed = this.parseAndVerifyToken(input.ref, prefix);

    if (!parsed) {
      return { state: 'CONTEXT_CHANGED' };
    }

    const reference = await this.prisma.telegramCallbackReference.findUnique({
      where: { id: parsed.referenceId },
      select: CALLBACK_REFERENCE_SELECT,
    });

    if (
      !reference ||
      !reference.backReferenceId ||
      !this.referenceMatchesContext(reference, resolution.context) ||
      (reference.purpose !== TelegramCallbackPurpose.NOTE_INPUT &&
        reference.purpose !== TelegramCallbackPurpose.NOTE_CONFIRM)
    ) {
      return { state: 'CONTEXT_CHANGED' };
    }

    if (reference.expiresAt <= new Date()) {
      return { state: 'EXPIRED_REF' };
    }

    await this.entitlements.assertActive(resolution.context.tenantId);

    const replay = await this.noteActionReplay(reference.id);

    if (replay) {
      return replay;
    }

    const cancelled = await this.prisma.telegramCallbackReference.updateMany({
      where: {
        id: reference.id,
        noteClaimedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: {
        expiresAt: new Date(0),
        noteBodyEncrypted: null,
      },
    });

    if (cancelled.count !== 1) {
      return (
        (await this.noteActionReplay(reference.id)) ?? {
          state: 'EXPIRED_REF',
        }
      );
    }

    return {
      state: 'CANCELLED',
      detailRef: this.tokenForReferenceId('d', reference.backReferenceId),
    };
  }

  async confirmNote(
    input: TelegramOrderDetailDto
  ): Promise<TelegramOrderNoteMutationResult> {
    const resolution = await this.resolveContext(input.telegram);

    if (resolution.state !== 'OK') {
      return { state: resolution.state };
    }

    const context = resolution.context;

    if (context.role === MembershipRole.MEMBER) {
      return { state: 'FORBIDDEN_ROLE' };
    }

    await this.clearExpiredNoteBodies(context);

    const parsed = this.parseAndVerifyToken(input.ref, 'c');

    if (!parsed) {
      return { state: 'CONTEXT_CHANGED' };
    }

    const reference = await this.prisma.telegramCallbackReference.findUnique({
      where: { id: parsed.referenceId },
      select: CALLBACK_REFERENCE_SELECT,
    });

    if (
      !reference ||
      reference.purpose !== TelegramCallbackPurpose.NOTE_CONFIRM ||
      !this.referenceMatchesContext(reference, context)
    ) {
      return { state: 'CONTEXT_CHANGED' };
    }

    if (
      !reference.targetWcOrderId ||
      !reference.backReferenceId ||
      !reference.noteVisibility ||
      !reference.noteContentFingerprint
    ) {
      return { state: 'CONTEXT_CHANGED' };
    }

    const replay = await this.noteActionReplay(reference.id);

    if (replay) {
      return replay;
    }

    if (reference.expiresAt <= new Date()) {
      return { state: 'EXPIRED_REF' };
    }

    if (!reference.noteBodyEncrypted) {
      return { state: 'CONTEXT_CHANGED' };
    }

    await this.entitlements.assertActive(context.tenantId);

    const order = await this.prisma.order.findFirst({
      where: {
        tenantId: context.tenantId,
        storeId: context.storeId,
        wcOrderId: reference.targetWcOrderId,
        tenant: { deletedAt: null },
        store: { deletedAt: null, status: StoreStatus.ACTIVE },
      },
      select: { orderNumber: true, remoteDeletedAt: true },
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

    let note: string;

    try {
      note = this.encryption.decrypt(reference.noteBodyEncrypted);
    } catch {
      return { state: 'FAILED' };
    }

    if (this.noteFingerprint(note) !== reference.noteContentFingerprint) {
      return { state: 'FAILED' };
    }

    try {
      await this.entitlements.assertActive(context.tenantId);
      const authoritative = await this.createWooCommerceClient(
        store
      ).fetchOrder(reference.targetWcOrderId);
      await this.orderProjection.reconcileAuthoritativeOrder(
        store,
        authoritative,
        reference.targetWcOrderId
      );
    } catch (error: unknown) {
      return { state: this.failureState(error) };
    }

    const detailRef = this.tokenForReferenceId('d', reference.backReferenceId);
    const targetWcOrderId = reference.targetWcOrderId;
    const visibility = reference.noteVisibility;
    const contentFingerprint = reference.noteContentFingerprint;
    let actionId: string;

    try {
      const action = await this.prisma.$transaction(
        async (transaction) => {
          const claimed =
            await transaction.telegramCallbackReference.updateMany({
              where: {
                id: reference.id,
                purpose: TelegramCallbackPurpose.NOTE_CONFIRM,
                noteClaimedAt: null,
                expiresAt: { gt: new Date() },
              },
              data: { noteClaimedAt: new Date() },
            });

          if (claimed.count !== 1) {
            throw new NoteAlreadyClaimedError();
          }

          return transaction.telegramOrderNoteAction.create({
            data: {
              id: `tona_${randomBytes(16).toString('hex')}`,
              callbackReferenceId: reference.id,
              telegramAccountId: context.accountId,
              tenantId: context.tenantId,
              storeId: context.storeId,
              wcOrderId: targetWcOrderId,
              visibility,
              contentFingerprint,
            },
            select: { id: true },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
      actionId = action.id;
    } catch (error: unknown) {
      if (
        !(error instanceof NoteAlreadyClaimedError) &&
        !isUniqueConstraintError(error)
      ) {
        throw error;
      }

      return (
        (await this.noteActionReplay(reference.id)) ?? {
          state: 'IN_PROGRESS',
          detailRef,
          visibility: reference.noteVisibility,
        }
      );
    }

    const customerNote =
      reference.noteVisibility === TelegramOrderNoteVisibility.CUSTOMER;

    try {
      await this.entitlements.assertActive(context.tenantId);
      const response = await this.createWooCommerceClient(
        store
      ).createOrderNote(reference.targetWcOrderId, note, customerNote);

      if (!isConfirmedWooCommerceNote(response, customerNote)) {
        return this.completeNoteAction(
          actionId,
          TelegramOrderNoteActionState.AMBIGUOUS,
          {
            state: 'AMBIGUOUS',
            detailRef,
            visibility: reference.noteVisibility,
          },
          reference.id
        );
      }

      const result: TelegramOrderNoteMutationResult = {
        state: 'OK',
        detailRef,
        visibility: reference.noteVisibility,
        orderNumber: order.orderNumber,
      };
      const completedAt = new Date();

      await this.prisma.$transaction([
        this.prisma.telegramOrderNoteAction.update({
          where: { id: actionId },
          data: {
            state: TelegramOrderNoteActionState.SUCCEEDED,
            result: result as unknown as Prisma.InputJsonObject,
            completedAt,
          },
          select: { id: true },
        }),
        this.prisma.telegramCallbackReference.update({
          where: { id: reference.id },
          data: { noteBodyEncrypted: null },
          select: { id: true },
        }),
        this.prisma.auditLog.create({
          data: {
            id: `aud_${randomBytes(16).toString('hex')}`,
            tenantId: context.tenantId,
            userId: context.userId,
            action: 'telegram.order.note.created',
            entityType: 'Order',
            entityId: reference.targetWcOrderId,
            metadata: {
              storeId: context.storeId,
              visibility: reference.noteVisibility,
              result: 'SUCCEEDED',
            },
          },
          select: { id: true },
        }),
      ]);

      return result;
    } catch (error: unknown) {
      const state = isAmbiguousNoteWriteFailure(error)
        ? TelegramOrderNoteActionState.AMBIGUOUS
        : TelegramOrderNoteActionState.FAILED;
      const resultState =
        state === TelegramOrderNoteActionState.AMBIGUOUS
          ? 'AMBIGUOUS'
          : this.failureState(error);

      return this.completeNoteAction(
        actionId,
        state,
        {
          state: resultState,
          detailRef,
          visibility: reference.noteVisibility,
        },
        reference.id
      );
    }
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

    await this.entitlements.assertActive(context.tenantId);

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

    await this.entitlements.assertActive(context.tenantId);

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
      await this.entitlements.assertActive(context.tenantId);
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
      await this.entitlements.assertActive(context.tenantId);
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
      if (error instanceof EntitlementInactiveException) {
        return this.completeFailure(writeId, 'FAILED');
      }

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

  private async resolveNoteDetailReference(
    input: TelegramOrderDetailDto
  ): Promise<
    | {
        state: 'OK';
        context: TelegramOrderContext;
        reference: CallbackReference & {
          targetWcOrderId: string;
          backReferenceId: string;
        };
      }
    | {
        state:
          | 'NOT_FOUND'
          | 'DELETED'
          | 'NO_ACTIVE_STORE'
          | 'UNAUTHORIZED'
          | 'CONTEXT_CHANGED'
          | 'FORBIDDEN_ROLE';
      }
  > {
    const resolution = await this.resolveContext(input.telegram);

    if (resolution.state !== 'OK') {
      return { state: resolution.state };
    }

    const context = resolution.context;

    if (context.role === MembershipRole.MEMBER) {
      return { state: 'FORBIDDEN_ROLE' };
    }

    await this.clearExpiredNoteBodies(context);

    const reference = await this.validateReference(
      input.ref,
      TelegramCallbackPurpose.ORDER_DETAIL,
      context
    );

    if (!reference?.targetWcOrderId || !reference.backReferenceId) {
      return { state: 'CONTEXT_CHANGED' };
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

    return {
      state: 'OK',
      context,
      reference: reference as CallbackReference & {
        targetWcOrderId: string;
        backReferenceId: string;
      },
    };
  }

  private async noteActionReplay(
    callbackReferenceId: string
  ): Promise<TelegramOrderNoteMutationResult | undefined> {
    const action = await this.prisma.telegramOrderNoteAction.findUnique({
      where: { callbackReferenceId },
      select: {
        id: true,
        state: true,
        result: true,
        startedAt: true,
        visibility: true,
        callbackReference: { select: { backReferenceId: true } },
      },
    });

    if (!action) {
      return undefined;
    }

    if (action.result) {
      return action.result as unknown as TelegramOrderNoteMutationResult;
    }

    const detailRef = action.callbackReference.backReferenceId
      ? this.tokenForReferenceId('d', action.callbackReference.backReferenceId)
      : undefined;

    if (
      action.state === TelegramOrderNoteActionState.IN_FLIGHT &&
      Date.now() - action.startedAt.getTime() >= NOTE_IN_FLIGHT_AMBIGUITY_MS
    ) {
      return this.completeNoteAction(
        action.id,
        TelegramOrderNoteActionState.AMBIGUOUS,
        {
          state: 'AMBIGUOUS',
          ...(detailRef ? { detailRef } : {}),
          visibility: action.visibility,
        },
        callbackReferenceId
      );
    }

    return {
      state: 'IN_PROGRESS',
      ...(detailRef ? { detailRef } : {}),
      visibility: action.visibility,
    };
  }

  private async clearExpiredNoteBodies(
    context: TelegramOrderContext
  ): Promise<void> {
    await this.prisma.telegramCallbackReference.updateMany({
      where: {
        telegramAccountId: context.accountId,
        telegramChatId: context.telegramChatId,
        tenantId: context.tenantId,
        storeId: context.storeId,
        purpose: TelegramCallbackPurpose.NOTE_CONFIRM,
        noteClaimedAt: null,
        noteBodyEncrypted: { not: null },
        expiresAt: { lte: new Date() },
      },
      data: { noteBodyEncrypted: null },
    });
  }

  private async completeNoteAction(
    actionId: string,
    state:
      | typeof TelegramOrderNoteActionState.FAILED
      | typeof TelegramOrderNoteActionState.AMBIGUOUS,
    result: TelegramOrderNoteMutationResult,
    callbackReferenceId: string
  ): Promise<TelegramOrderNoteMutationResult> {
    await this.prisma.$transaction([
      this.prisma.telegramOrderNoteAction.update({
        where: { id: actionId },
        data: {
          state,
          result: result as unknown as Prisma.InputJsonObject,
          completedAt: new Date(),
        },
        select: { id: true },
      }),
      this.prisma.telegramCallbackReference.update({
        where: { id: callbackReferenceId },
        data: { noteBodyEncrypted: null },
        select: { id: true },
      }),
    ]);

    return result;
  }

  private noteFingerprint(note: string): string {
    return createHmac('sha256', this.configuration.telegram.callbackSigningKey)
      .update(note)
      .digest('hex');
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
        id: true,
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
        membershipId: membership.id,
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
    prefix: 'p' | 'd' | 's' | 'i',
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
      | 'noteVisibility'
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
    prefix: 'p' | 'd' | 's' | 'i' | 'c',
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
    expectedPrefix: 'p' | 'd' | 's' | 'i' | 'c'
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
      payment: safePayment(order.paymentSnapshot),
      shipping: safeShipping(
        order.customerSnapshot,
        order.shippingLinesSnapshot
      ),
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

function safePayment(value: Prisma.JsonValue): TelegramOrderDetail['payment'] {
  const payment = jsonRecord(value);
  const methodTitle = safeContextLine(payment?.['method_title']);
  const method = safeContextLine(payment?.['method']);

  return {
    method: methodTitle || method || null,
    paid: payment?.['paid'] === true,
  };
}

function safeShipping(
  customerSnapshot: Prisma.JsonValue,
  shippingLinesSnapshot: Prisma.JsonValue
): TelegramOrderDetail['shipping'] {
  const shipping = jsonRecord(jsonRecord(customerSnapshot)?.['shipping']);
  const addressLines = [
    safeContextLine(shipping?.['company']),
    safeContextLine(shipping?.['address_1']),
    safeContextLine(shipping?.['address_2']),
    [
      safeContextLine(shipping?.['city']),
      safeContextLine(shipping?.['state']),
      safeContextLine(shipping?.['postcode']),
    ]
      .filter(Boolean)
      .join(', '),
    safeContextLine(shipping?.['country']),
  ].filter((value): value is string => Boolean(value));
  const methods = Array.isArray(shippingLinesSnapshot)
    ? shippingLinesSnapshot.flatMap((line) => {
        const record = jsonRecord(line);
        const method =
          safeContextLine(record?.['method_title']) ||
          safeContextLine(record?.['method_id']);

        return method ? [method] : [];
      })
    : [];

  return {
    methods: [...new Set(methods)],
    addressLines,
  };
}

function safeContextLine(value: Prisma.JsonValue | undefined): string {
  return typeof value === 'string'
    ? Array.from(value)
        .map((character) => {
          const code = character.charCodeAt(0);
          return code <= 31 || code === 127 ? ' ' : character;
        })
        .join('')
        .trim()
        .slice(0, 191)
    : '';
}

function normalizeOrderNote(value: string): string | undefined {
  const note = value.trim();

  if (
    note.length === 0 ||
    note.length > TELEGRAM_ORDER_NOTE_MAX_LENGTH ||
    /[<>]/.test(note) ||
    Array.from(note).some((character) => {
      const code = character.charCodeAt(0);
      return (
        code <= 8 ||
        code === 11 ||
        code === 12 ||
        (code >= 14 && code <= 31) ||
        code === 127
      );
    })
  ) {
    return undefined;
  }

  return note;
}

function notePreview(note: string): string {
  const compact = note.replace(/\s+/g, ' ').trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 237)}...`;
}

function isConfirmedWooCommerceNote(
  value: unknown,
  customerNote: boolean
): boolean {
  const record =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const id = record?.['id'];

  return (
    ((typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ||
      (typeof id === 'string' && /^[1-9]\d*$/.test(id))) &&
    record?.['customer_note'] === customerNote
  );
}

function isAmbiguousNoteWriteFailure(error: unknown): boolean {
  return (
    !(error instanceof WooCommerceClientError) ||
    error.category === 'transport' ||
    error.category === 'timeout'
  );
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

class NoteAlreadyClaimedError extends Error {
  constructor() {
    super('Order note action is already claimed');
    this.name = 'NoteAlreadyClaimedError';
  }
}
