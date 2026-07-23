import { Injectable } from '@nestjs/common';
import {
  MembershipRole,
  Prisma,
  StoreStatus,
  TelegramCallbackDirection,
  TelegramCallbackPurpose,
} from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { ApplicationConfigService } from '../config/application-config.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  TelegramOrderDetailDto,
  TelegramOrderIdentityDto,
  TelegramOrderListDto,
} from './dto/telegram-internal.dto';

const PAGE_SIZE = 8;
const REACHABLE_ORDER_CAP = 200;
const CALLBACK_ID_BYTES = 12;
const CALLBACK_SIGNATURE_BYTES = 12;
const EMPTY_FRESHNESS_DATE = new Date(0);

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
  freshness: TelegramOrderFreshness;
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

@Injectable()
export class TelegramOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configuration: ApplicationConfigService
  ) {}

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
      freshness,
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

  private newReference(
    prefix: 'p' | 'd',
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

  private tokenForReferenceId(prefix: 'p' | 'd', referenceId: string): string {
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
    expectedPrefix: 'p' | 'd'
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
