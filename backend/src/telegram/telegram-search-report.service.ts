import { Injectable } from '@nestjs/common';
import {
  InventoryAlertClassification,
  InventorySyncState,
  MembershipRole,
  Prisma,
  StoreStatus,
  TelegramChatType,
  TelegramSearchReferencePurpose,
  TelegramSearchResultKind,
} from '@prisma/client';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { EncryptionService } from '../common/encryption/encryption.service';
import { ApplicationConfigService } from '../config/application-config.service';
import {
  type TelegramProjectedStockDetailResult,
  TelegramInventoryService,
} from '../inventory/telegram-inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  TelegramOrderIdentityDto,
  TelegramSearchDto,
  TelegramSearchSelectDto,
} from './dto/telegram-internal.dto';
import {
  type TelegramOrderDetailResult,
  TelegramOrderService,
} from './telegram-order.service';

const PAGE_SIZE = 8;
const MAX_REACHABLE = 200;
const MAX_QUERY_LENGTH = 80;
const NUMERIC_SKU_PATTERN = /^\d+$/u;
const REFERENCE_ID_BYTES = 12;
const REFERENCE_SIGNATURE_BYTES = 12;
const REVENUE_STATUSES = new Set(['processing', 'completed']);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

interface SearchContext {
  accountId: string;
  membershipId: string;
  telegramChatId: bigint;
  tenantId: string;
  storeId: string;
  timezone: string;
  inventorySyncState: InventorySyncState;
}

type ContextResolution =
  | { state: 'UNAUTHORIZED' | 'NO_ACTIVE_STORE' }
  | { state: 'OK'; context: SearchContext };

interface SearchRow {
  entity_kind: 'ORDER' | 'INVENTORY';
  target_id: string;
  stable_identity: string;
  rank: number;
  order_number: string | null;
  status: string;
  customer_display_name: string | null;
  currency: string | null;
  total: string | null;
  wc_created_at: Date | null;
  display_name: string | null;
  sku: string | null;
  quantity: string | null;
  classification: InventoryAlertClassification | null;
  inventory_kind: 'PRODUCT' | 'VARIATION' | null;
}

export interface TelegramSearchRow {
  ref: string;
  kind: 'ORDER' | 'INVENTORY';
  orderNumber?: string;
  status: string;
  customerDisplayName?: string;
  currency?: string;
  total?: string;
  wcCreatedAt?: string;
  displayName?: string;
  sku?: string | null;
  quantity?: string | null;
  classification?: InventoryAlertClassification;
  inventoryKind?: 'PRODUCT' | 'VARIATION';
}

export type TelegramSearchResult =
  | {
      state:
        | 'INVALID_QUERY'
        | 'QUERY_TOO_SHORT'
        | 'UNAUTHORIZED'
        | 'NO_ACTIVE_STORE'
        | 'CONTEXT_CHANGED';
    }
  | { state: 'ORDER_DETAIL'; detail: TelegramOrderDetailResult }
  | {
      state: 'OK';
      results: TelegramSearchRow[];
      nextCursor: string | null;
      previousCursor: string | null;
      inventoryState: InventorySyncState;
    };

export type TelegramSearchSelectionResult =
  | {
      state:
        | 'UNAUTHORIZED'
        | 'NO_ACTIVE_STORE'
        | 'CONTEXT_CHANGED'
        | 'NOT_FOUND'
        | 'SYNCING';
    }
  | {
      state: 'ORDER';
      detail: TelegramOrderDetailResult;
      backCursor: string;
    }
  | {
      state: 'INVENTORY';
      detail: TelegramProjectedStockDetailResult;
      backCursor: string;
    };

export interface TelegramDailyReportCurrency {
  currency: string;
  gross: string;
  averageOrderValue: string;
  orderCount: number;
}

export type TelegramDailyReportResult =
  | { state: 'UNAUTHORIZED' | 'NO_ACTIVE_STORE' }
  | {
      state: 'OK';
      localDate: string;
      timezone: string;
      dayStartUtc: string;
      nextDayStartUtc: string;
      ordersToday: number;
      statuses: Array<{ status: string; count: number }>;
      sales: TelegramDailyReportCurrency[];
      omittedRevenueOrders: number;
      inventory:
        | { state: 'READY'; lowStock: number; outOfStock: number }
        | { state: 'UNAVAILABLE'; syncState: InventorySyncState };
      projection: { asOf: string | null; delayed: boolean };
    };

const SEARCH_REFERENCE_SELECT = {
  id: true,
  telegramAccountId: true,
  telegramChatId: true,
  tenantId: true,
  membershipId: true,
  storeId: true,
  purpose: true,
  queryEncrypted: true,
  pageOffset: true,
  resultKind: true,
  targetWcOrderId: true,
  targetInventoryItemId: true,
  backReferenceId: true,
  expiresAt: true,
} satisfies Prisma.TelegramSearchReferenceSelect;

type SearchReference = Prisma.TelegramSearchReferenceGetPayload<{
  select: typeof SEARCH_REFERENCE_SELECT;
}>;

@Injectable()
export class TelegramSearchReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configuration: ApplicationConfigService,
    private readonly encryption: EncryptionService,
    private readonly orders: TelegramOrderService,
    private readonly inventory: TelegramInventoryService
  ) {}

  async search(input: TelegramSearchDto): Promise<TelegramSearchResult> {
    const resolved = await this.resolveContext(input.telegram);

    if (resolved.state !== 'OK') {
      return { state: resolved.state };
    }

    const context = resolved.context;
    let normalized: string;
    let offset = 0;

    if (input.cursor) {
      const pageReference = await this.validateReference(
        input.cursor,
        'q',
        TelegramSearchReferencePurpose.PAGE,
        context
      );

      if (
        !pageReference?.queryEncrypted ||
        pageReference.pageOffset === null ||
        pageReference.pageOffset < 0 ||
        pageReference.pageOffset >= MAX_REACHABLE ||
        pageReference.pageOffset % PAGE_SIZE !== 0
      ) {
        return { state: 'CONTEXT_CHANGED' };
      }

      try {
        normalized = this.encryption.decrypt(pageReference.queryEncrypted);
      } catch {
        return { state: 'CONTEXT_CHANGED' };
      }
      offset = pageReference.pageOffset;
    } else {
      const query = input.query?.trim() ?? '';

      if (!query || query.length > MAX_QUERY_LENGTH) {
        return { state: 'INVALID_QUERY' };
      }

      normalized = query.normalize('NFKC').toLocaleLowerCase('und');
      const exactOrders = await this.prisma.order.findMany({
        where: {
          tenantId: context.tenantId,
          storeId: context.storeId,
          remoteDeletedAt: null,
          orderNumber: { equals: query, mode: 'insensitive' },
        },
        select: { wcOrderId: true },
        take: 2,
      });

      if (exactOrders.length === 1) {
        return {
          state: 'ORDER_DETAIL',
          detail: await this.orders.openProjectedDetail({
            telegram: input.telegram,
            wcOrderId: exactOrders[0]!.wcOrderId,
          }),
        };
      }

      if (this.usefulLength(normalized) < 2) {
        const exactSku = await this.prisma.inventoryItem.count({
          where: {
            tenantId: context.tenantId,
            storeId: context.storeId,
            remoteDeletedAt: null,
            sku: { equals: query, mode: 'insensitive' },
          },
        });

        if (exactSku === 0) {
          return { state: 'QUERY_TOO_SHORT' };
        }
      }
    }

    if (!normalized || normalized.length > MAX_QUERY_LENGTH) {
      return { state: 'CONTEXT_CHANGED' };
    }

    const exactNumericSkuItemIds = await this.exactNumericSkuItemIds(
      context,
      normalized
    );
    const rows = await this.querySearch(
      context,
      normalized,
      offset,
      exactNumericSkuItemIds
    );
    const pageRows = rows.slice(0, PAGE_SIZE);
    const expiresAt = this.referenceExpiry();
    const current = this.newPageReference(
      context,
      normalized,
      offset,
      expiresAt
    );
    const resultReferences = pageRows.map((row) =>
      this.newResultReference(context, row, current.data.id, expiresAt)
    );
    let previousCursor: string | null = null;
    let nextCursor: string | null = null;
    const additional: Prisma.TelegramSearchReferenceCreateManyInput[] = [];

    if (offset > 0) {
      const previous = this.newPageReference(
        context,
        normalized,
        Math.max(0, offset - PAGE_SIZE),
        expiresAt
      );
      additional.push(previous.data);
      previousCursor = previous.token;
    }

    if (rows.length > PAGE_SIZE && offset + PAGE_SIZE < MAX_REACHABLE) {
      const next = this.newPageReference(
        context,
        normalized,
        offset + PAGE_SIZE,
        expiresAt
      );
      additional.push(next.data);
      nextCursor = next.token;
    }

    await this.prisma.telegramSearchReference.createMany({
      data: [
        current.data,
        ...resultReferences.map((reference) => reference.data),
        ...additional,
      ],
    });

    return {
      state: 'OK',
      results: pageRows.map((row, index) =>
        this.mapSearchRow(row, resultReferences[index]!.token)
      ),
      nextCursor,
      previousCursor,
      inventoryState: context.inventorySyncState,
    };
  }

  async select(
    input: TelegramSearchSelectDto
  ): Promise<TelegramSearchSelectionResult> {
    const resolved = await this.resolveContext(input.telegram);

    if (resolved.state !== 'OK') {
      return { state: resolved.state };
    }

    const context = resolved.context;
    const reference = await this.validateReference(
      input.ref,
      'u',
      TelegramSearchReferencePurpose.RESULT,
      context
    );

    if (!reference?.backReferenceId) {
      return { state: 'CONTEXT_CHANGED' };
    }

    const back = await this.prisma.telegramSearchReference.findFirst({
      where: {
        id: reference.backReferenceId,
        telegramAccountId: context.accountId,
        telegramChatId: context.telegramChatId,
        tenantId: context.tenantId,
        membershipId: context.membershipId,
        storeId: context.storeId,
        purpose: TelegramSearchReferencePurpose.PAGE,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });

    if (!back) {
      return { state: 'CONTEXT_CHANGED' };
    }

    const backCursor = this.tokenForReferenceId('q', back.id);

    if (
      reference.resultKind === TelegramSearchResultKind.ORDER &&
      reference.targetWcOrderId
    ) {
      const detail = await this.orders.openProjectedDetail({
        telegram: input.telegram,
        wcOrderId: reference.targetWcOrderId,
      });
      return detail.state === 'NOT_FOUND'
        ? { state: 'NOT_FOUND' }
        : { state: 'ORDER', detail, backCursor };
    }

    if (
      reference.resultKind === TelegramSearchResultKind.INVENTORY &&
      reference.targetInventoryItemId
    ) {
      const detail = await this.inventory.openProjectedDetail({
        telegram: input.telegram,
        inventoryItemId: reference.targetInventoryItemId,
      });
      return detail.state === 'OK'
        ? { state: 'INVENTORY', detail, backCursor }
        : { state: detail.state };
    }

    return { state: 'CONTEXT_CHANGED' };
  }

  async report(input: {
    telegram: TelegramOrderIdentityDto;
  }): Promise<TelegramDailyReportResult> {
    const resolved = await this.resolveContext(input.telegram);

    if (resolved.state !== 'OK') {
      return { state: resolved.state };
    }

    const context = resolved.context;
    const bounds = tenantDayBounds(new Date(), context.timezone);
    const orders = await this.prisma.order.findMany({
      where: {
        tenantId: context.tenantId,
        storeId: context.storeId,
        remoteDeletedAt: null,
        wcCreatedAt: { gte: bounds.start, lt: bounds.end },
      },
      select: {
        status: true,
        currency: true,
        totals: true,
        lastSyncedAt: true,
      },
    });
    const statuses = new Map<string, number>();
    const sales = new Map<string, { total: Prisma.Decimal; count: number }>();
    let omittedRevenueOrders = 0;
    let newestSyncMs: number | null = null;

    for (const order of orders) {
      statuses.set(order.status, (statuses.get(order.status) ?? 0) + 1);
      newestSyncMs = Math.max(newestSyncMs ?? 0, order.lastSyncedAt.getTime());

      if (!REVENUE_STATUSES.has(order.status)) {
        continue;
      }

      const total = this.readTotal(order.totals);

      if (!CURRENCY_PATTERN.test(order.currency) || total === null) {
        omittedRevenueOrders += 1;
        continue;
      }

      const existing = sales.get(order.currency) ?? {
        total: new Prisma.Decimal(0),
        count: 0,
      };
      existing.total = existing.total.plus(total);
      existing.count += 1;
      sales.set(order.currency, existing);
    }

    const inventory =
      context.inventorySyncState === InventorySyncState.READY
        ? await this.readyInventoryCounts(context)
        : {
            state: 'UNAVAILABLE' as const,
            syncState: context.inventorySyncState,
          };
    const freshnessLimit =
      this.configuration.telegram.orderFreshnessThresholdSeconds * 1000;

    return {
      state: 'OK',
      localDate: bounds.localDate,
      timezone: context.timezone,
      dayStartUtc: bounds.start.toISOString(),
      nextDayStartUtc: bounds.end.toISOString(),
      ordersToday: orders.length,
      statuses: [...statuses.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([status, count]) => ({ status, count })),
      sales: [...sales.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, value]) => ({
          currency,
          gross: value.total.toFixed(2),
          averageOrderValue: value.total.div(value.count).toFixed(2),
          orderCount: value.count,
        })),
      omittedRevenueOrders,
      inventory,
      projection: {
        asOf:
          newestSyncMs === null ? null : new Date(newestSyncMs).toISOString(),
        delayed:
          newestSyncMs === null || Date.now() - newestSyncMs > freshnessLimit,
      },
    };
  }

  private async querySearch(
    context: SearchContext,
    normalized: string,
    offset: number,
    exactNumericSkuItemIds: string[]
  ): Promise<SearchRow[]> {
    const prefix = `${this.escapeLike(normalized)}%`;
    const inventoryEnabled =
      context.inventorySyncState === InventorySyncState.READY;
    const exactNumericSkuMatch =
      exactNumericSkuItemIds.length === 0
        ? Prisma.sql`FALSE`
        : Prisma.sql`i.id IN (${Prisma.join(exactNumericSkuItemIds)})`;

    return this.prisma.$queryRaw<SearchRow[]>(Prisma.sql`
      WITH candidates AS (
        SELECT
          'ORDER'::text AS entity_kind,
          o.wc_order_id AS target_id,
          o.wc_order_id AS stable_identity,
          CASE
            WHEN lower(o.order_number) = ${normalized} THEN 0
            WHEN lower(COALESCE(NULLIF(btrim(COALESCE(NULLIF(btrim(o.customer_snapshot->'billing'->>'first_name'), ''), '') || ' ' || COALESCE(NULLIF(btrim(o.customer_snapshot->'billing'->>'last_name'), ''), '')), ''), NULLIF(btrim(o.customer_snapshot->'billing'->>'company'), ''), 'Guest')) = ${normalized} THEN 2
            WHEN lower(o.order_number) LIKE ${prefix} ESCAPE '\\' THEN 3
            ELSE 4
          END AS rank,
          o.order_number,
          o.status,
          COALESCE(NULLIF(btrim(COALESCE(NULLIF(btrim(o.customer_snapshot->'billing'->>'first_name'), ''), '') || ' ' || COALESCE(NULLIF(btrim(o.customer_snapshot->'billing'->>'last_name'), ''), '')), ''), NULLIF(btrim(o.customer_snapshot->'billing'->>'company'), ''), 'Guest') AS customer_display_name,
          o.currency,
          o.totals->>'total' AS total,
          o.wc_created_at,
          NULL::text AS display_name,
          NULL::text AS sku,
          NULL::text AS quantity,
          NULL::inventory_alert_classification AS classification,
          NULL::text AS inventory_kind
        FROM orders o
        WHERE o.tenant_id = ${context.tenantId}
          AND o.store_id = ${context.storeId}
          AND o.remote_deleted_at IS NULL
          AND (
            lower(o.order_number) = ${normalized}
            OR lower(o.order_number) LIKE ${prefix} ESCAPE '\\'
            OR lower(COALESCE(NULLIF(btrim(COALESCE(NULLIF(btrim(o.customer_snapshot->'billing'->>'first_name'), ''), '') || ' ' || COALESCE(NULLIF(btrim(o.customer_snapshot->'billing'->>'last_name'), ''), '')), ''), NULLIF(btrim(o.customer_snapshot->'billing'->>'company'), ''), 'Guest')) = ${normalized}
            OR lower(COALESCE(NULLIF(btrim(COALESCE(NULLIF(btrim(o.customer_snapshot->'billing'->>'first_name'), ''), '') || ' ' || COALESCE(NULLIF(btrim(o.customer_snapshot->'billing'->>'last_name'), ''), '')), ''), NULLIF(btrim(o.customer_snapshot->'billing'->>'company'), ''), 'Guest')) LIKE ${prefix} ESCAPE '\\'
          )

        UNION ALL

        SELECT
          'INVENTORY'::text AS entity_kind,
          i.id AS target_id,
          i.wc_item_id AS stable_identity,
          CASE
            WHEN ${exactNumericSkuMatch} THEN 1
            WHEN lower(i.sku) = ${normalized} THEN 1
            WHEN lower(i.display_name) = ${normalized} THEN 2
            WHEN lower(i.sku) LIKE ${prefix} ESCAPE '\\' THEN 3
            ELSE 4
          END AS rank,
          NULL::text AS order_number,
          i.stock_status AS status,
          NULL::text AS customer_display_name,
          NULL::text AS currency,
          NULL::text AS total,
          NULL::timestamptz AS wc_created_at,
          i.display_name,
          i.sku,
          i.stock_quantity::text AS quantity,
          i.alert_classification AS classification,
          i.kind::text AS inventory_kind
        FROM inventory_items i
        WHERE ${inventoryEnabled}
          AND i.tenant_id = ${context.tenantId}
          AND i.store_id = ${context.storeId}
          AND i.remote_deleted_at IS NULL
          AND (
            ${exactNumericSkuMatch}
            OR lower(i.sku) = ${normalized}
            OR lower(i.sku) LIKE ${prefix} ESCAPE '\\'
            OR lower(i.display_name) = ${normalized}
            OR lower(i.display_name) LIKE ${prefix} ESCAPE '\\'
          )
      )
      SELECT *
      FROM candidates
      ORDER BY
        rank ASC,
        CASE entity_kind WHEN 'ORDER' THEN 0 ELSE 1 END ASC,
        CASE WHEN entity_kind = 'ORDER' THEN wc_created_at END DESC NULLS LAST,
        CASE WHEN entity_kind = 'ORDER' THEN stable_identity END ASC NULLS LAST,
        CASE WHEN entity_kind = 'INVENTORY' THEN lower(display_name) END ASC NULLS LAST,
        CASE WHEN entity_kind = 'INVENTORY' THEN stable_identity END ASC NULLS LAST
      OFFSET ${offset}
      LIMIT ${PAGE_SIZE + 1}
    `);
  }

  private async exactNumericSkuItemIds(
    context: SearchContext,
    normalized: string
  ): Promise<string[]> {
    if (
      context.inventorySyncState !== InventorySyncState.READY ||
      !NUMERIC_SKU_PATTERN.test(normalized)
    ) {
      return [];
    }

    const items = await this.prisma.inventoryItem.findMany({
      where: {
        tenantId: context.tenantId,
        storeId: context.storeId,
        remoteDeletedAt: null,
        sku: normalized,
      },
      select: { id: true },
      orderBy: [{ displayName: 'asc' }, { wcItemId: 'asc' }],
      take: MAX_REACHABLE,
    });

    return items.map((item) => item.id);
  }

  private async readyInventoryCounts(context: SearchContext) {
    const groups = await this.prisma.inventoryItem.groupBy({
      by: ['alertClassification'],
      where: {
        tenantId: context.tenantId,
        storeId: context.storeId,
        remoteDeletedAt: null,
        alertClassification: {
          in: [
            InventoryAlertClassification.LOW_STOCK,
            InventoryAlertClassification.OUT_OF_STOCK,
          ],
        },
      },
      _count: { _all: true },
    });
    const count = (classification: InventoryAlertClassification) =>
      groups.find((group) => group.alertClassification === classification)
        ?._count._all ?? 0;

    return {
      state: 'READY' as const,
      lowStock: count(InventoryAlertClassification.LOW_STOCK),
      outOfStock: count(InventoryAlertClassification.OUT_OF_STOCK),
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
        role: {
          in: [
            MembershipRole.OWNER,
            MembershipRole.ADMIN,
            MembershipRole.MEMBER,
          ],
        },
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

    const stores = await this.prisma.store.findMany({
      where: {
        tenantId: memberships[0]!.tenantId,
        status: StoreStatus.ACTIVE,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: {
        id: true,
        inventorySyncState: true,
        tenant: { select: { timezone: true } },
      },
      take: 2,
    });

    if (stores.length !== 1) {
      return { state: 'NO_ACTIVE_STORE' };
    }

    return {
      state: 'OK',
      context: {
        accountId: account.id,
        membershipId: memberships[0]!.id,
        telegramChatId,
        tenantId: memberships[0]!.tenantId,
        storeId: stores[0]!.id,
        timezone: stores[0]!.tenant.timezone,
        inventorySyncState: stores[0]!.inventorySyncState,
      },
    };
  }

  private async validateReference(
    token: string,
    prefix: 'q' | 'u',
    purpose: TelegramSearchReferencePurpose,
    context: SearchContext
  ): Promise<SearchReference | undefined> {
    const parsed = this.parseToken(token, prefix);

    if (!parsed) {
      return undefined;
    }

    const reference = await this.prisma.telegramSearchReference.findUnique({
      where: { id: parsed.referenceId },
      select: SEARCH_REFERENCE_SELECT,
    });

    return reference &&
      reference.expiresAt > new Date() &&
      reference.purpose === purpose &&
      reference.telegramAccountId === context.accountId &&
      reference.telegramChatId === context.telegramChatId &&
      reference.tenantId === context.tenantId &&
      reference.membershipId === context.membershipId &&
      reference.storeId === context.storeId
      ? reference
      : undefined;
  }

  private newPageReference(
    context: SearchContext,
    normalized: string,
    pageOffset: number,
    expiresAt: Date
  ) {
    return this.newReference('q', context, {
      purpose: TelegramSearchReferencePurpose.PAGE,
      queryEncrypted: this.encryption.encrypt(normalized),
      pageOffset,
      expiresAt,
    });
  }

  private newResultReference(
    context: SearchContext,
    row: SearchRow,
    backReferenceId: string,
    expiresAt: Date
  ) {
    return this.newReference('u', context, {
      purpose: TelegramSearchReferencePurpose.RESULT,
      resultKind:
        row.entity_kind === 'ORDER'
          ? TelegramSearchResultKind.ORDER
          : TelegramSearchResultKind.INVENTORY,
      targetWcOrderId: row.entity_kind === 'ORDER' ? row.target_id : undefined,
      targetInventoryItemId:
        row.entity_kind === 'INVENTORY' ? row.target_id : undefined,
      backReferenceId,
      expiresAt,
    });
  }

  private newReference(
    prefix: 'q' | 'u',
    context: SearchContext,
    values: Omit<
      Prisma.TelegramSearchReferenceCreateManyInput,
      | 'id'
      | 'telegramAccountId'
      | 'telegramChatId'
      | 'tenantId'
      | 'membershipId'
      | 'storeId'
    >
  ) {
    const shortId = randomBytes(REFERENCE_ID_BYTES).toString('base64url');
    const id = `tsr_${shortId}`;

    return {
      token: this.tokenForReferenceId(prefix, id),
      data: {
        id,
        telegramAccountId: context.accountId,
        telegramChatId: context.telegramChatId,
        tenantId: context.tenantId,
        membershipId: context.membershipId,
        storeId: context.storeId,
        ...values,
      } satisfies Prisma.TelegramSearchReferenceCreateManyInput,
    };
  }

  private tokenForReferenceId(prefix: 'q' | 'u', referenceId: string): string {
    const shortId = referenceId.replace(/^tsr_/, '');
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

  private parseToken(token: string, prefix: 'q' | 'u') {
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

    return supplied.length === expected.length &&
      timingSafeEqual(supplied, expected)
      ? { referenceId: `tsr_${parts[1]}` }
      : undefined;
  }

  private mapSearchRow(row: SearchRow, ref: string): TelegramSearchRow {
    return row.entity_kind === 'ORDER'
      ? {
          ref,
          kind: 'ORDER',
          orderNumber: row.order_number ?? '',
          status: row.status,
          customerDisplayName: row.customer_display_name ?? 'Guest',
          currency: row.currency ?? '',
          total: row.total ?? '0',
          wcCreatedAt: row.wc_created_at?.toISOString() ?? '',
        }
      : {
          ref,
          kind: 'INVENTORY',
          status: row.status,
          displayName: row.display_name ?? '',
          sku: row.sku,
          quantity: row.quantity,
          classification:
            row.classification ?? InventoryAlertClassification.HEALTHY,
          inventoryKind: row.inventory_kind ?? 'PRODUCT',
        };
  }

  private readTotal(value: Prisma.JsonValue): Prisma.Decimal | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const raw = (value as Record<string, unknown>)['total'];
    const normalized =
      typeof raw === 'string'
        ? raw
        : typeof raw === 'number' && Number.isFinite(raw)
          ? raw.toString()
          : '';

    return DECIMAL_PATTERN.test(normalized)
      ? new Prisma.Decimal(normalized)
      : null;
  }

  private usefulLength(value: string): number {
    return Array.from(value).filter((character) => !/\s/u.test(character))
      .length;
  }

  private escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (character) => `\\${character}`);
  }

  private referenceExpiry(): Date {
    return new Date(
      Date.now() + this.configuration.telegram.callbackRefTtlSeconds * 1000
    );
  }
}

export function tenantDayBounds(
  instant: Date,
  timezone: string
): { localDate: string; start: Date; end: Date } {
  const localDate = dateInZone(instant, timezone);
  const nextDate = addCivilDay(localDate);

  return {
    localDate,
    start: firstInstantOfDate(localDate, timezone),
    end: firstInstantOfDate(nextDate, timezone),
  };
}

function dateInZone(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${value('year')}-${value('month')}-${value('day')}`;
}

function addCivilDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day! + 1));
  return next.toISOString().slice(0, 10);
}

function firstInstantOfDate(date: string, timezone: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const center = Date.UTC(year!, month! - 1, day!);
  let low = center - 48 * 60 * 60 * 1000;
  let high = center + 48 * 60 * 60 * 1000;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (dateInZone(new Date(middle), timezone) < date) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  if (dateInZone(new Date(low), timezone) !== date) {
    throw new Error('Tenant timezone does not contain the requested civil day');
  }

  return new Date(low);
}
