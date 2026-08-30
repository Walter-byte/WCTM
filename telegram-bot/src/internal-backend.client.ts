import type { BotConfiguration } from './config';

export interface TelegramIdentity {
  telegramUserId: string;
  telegramChatId: string;
  updateId: string;
}

export interface TelegramAuthorizationStatus {
  linked: boolean;
  authorized: boolean;
  membershipState: 'active' | 'none';
  activeTenantId: string | null;
  activeStoreId: string | null;
  tenantSelectionRequired: boolean;
  storeSelectionRequired: boolean;
  selectionRequired: boolean;
}

export type TelegramRedeemResult =
  | { status: 'invalid_or_expired' }
  | ({ status: 'linked' } & TelegramAuthorizationStatus);

export type TelegramUnlinkResult =
  | { status: 'confirmation_required' }
  | { status: 'unauthorized' }
  | { status: 'unlinked' };

export interface OrderFreshness {
  asOf: string;
  delayed: boolean;
}

export interface OrderSummary {
  ref: string;
  orderNumber: string;
  status: string;
  currency: string;
  total: string;
  customerDisplayName: string;
  wcCreatedAt: string;
  remoteDeleted: boolean;
}

export interface OrderListResult {
  state: 'OK' | 'NO_ACTIVE_STORE' | 'UNAUTHORIZED' | 'CONTEXT_CHANGED';
  orders: OrderSummary[];
  nextCursor: string | null;
  previousCursor: string | null;
  freshness: OrderFreshness;
}

export interface OrderLineItem {
  name: string;
  quantity: string | number;
  total: string;
}

export interface OrderDetailPayload {
  orderNumber: string;
  status: string;
  currency?: string;
  totals?: Readonly<Record<string, string | number>>;
  customerDisplayName: string;
  lineItems?: OrderLineItem[];
  payment?: { method: string | null; paid: boolean };
  shipping?: { methods: string[]; addressLines: string[] };
  wcCreatedAt?: string;
  wcModifiedAt?: string;
  remoteDeleted: boolean;
}

export interface OrderDetailResult {
  state:
    | 'OK'
    | 'NOT_FOUND'
    | 'DELETED'
    | 'CONTEXT_CHANGED'
    | 'NO_ACTIVE_STORE'
    | 'UNAUTHORIZED';
  order?: OrderDetailPayload;
  backCursor?: string;
  transitionsRef?: string;
  refreshRef?: string;
  addNoteRef?: string;
  freshness: OrderFreshness;
}

export interface OrderLookupResult extends Omit<OrderDetailResult, 'state'> {
  state: OrderDetailResult['state'] | 'MALFORMED_ORDER_NUMBER' | 'AMBIGUOUS';
}

export interface OrderRefreshResult extends Omit<OrderDetailResult, 'state'> {
  state: OrderDetailResult['state'] | 'RETRYABLE' | 'FAILED';
}

export type OrderNoteState =
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

export type OrderNoteVisibility = 'INTERNAL' | 'CUSTOMER';

export interface OrderNoteOptionsResult {
  state: OrderNoteState;
  ref?: string;
  visibilities?: OrderNoteVisibility[];
}

export interface OrderNoteStartResult {
  state: OrderNoteState;
  inputRef?: string;
  detailRef?: string;
  visibility?: OrderNoteVisibility;
  maxLength?: number;
}

export interface OrderNotePrepareResult {
  state: OrderNoteState;
  confirmRef?: string;
  detailRef?: string;
  visibility?: OrderNoteVisibility;
  preview?: string;
}

export interface OrderNoteMutationResult {
  state: OrderNoteState;
  detailRef?: string;
  visibility?: OrderNoteVisibility;
  orderNumber?: string;
}

export interface OrderTransitionsResult {
  state:
    | 'OK'
    | 'NOT_FOUND'
    | 'DELETED'
    | 'NO_ACTIVE_STORE'
    | 'UNAUTHORIZED'
    | 'CONTEXT_CHANGED'
    | 'FORBIDDEN_ROLE';
  ref?: string;
  currentStatus?: string;
  targets?: string[];
}

export interface OrderStatusUpdateResult {
  state:
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
  order?: OrderDetailPayload;
  backCursor?: string;
  freshness?: OrderFreshness;
}

export class BackendUnavailableError extends Error {
  constructor() {
    super('Backend is unavailable');
    this.name = 'BackendUnavailableError';
  }
}

export class MalformedBackendResponseError extends Error {
  constructor() {
    super('Backend returned an invalid response');
    this.name = 'MalformedBackendResponseError';
  }
}

export class InternalBackendClient {
  constructor(
    private readonly configuration: Pick<
      BotConfiguration,
      | 'internalApiKey'
      | 'backendInternalUrl'
      | 'backendTimeoutMs'
      | 'statusWriteTimeoutMs'
    >,
    private readonly request: typeof fetch = fetch
  ) {}

  redeem(
    identity: TelegramIdentity,
    token: string
  ): Promise<TelegramRedeemResult> {
    return this.post<TelegramRedeemResult>('redeem', identity, {
      ...identity,
      chatType: 'private',
      token,
    });
  }

  status(identity: TelegramIdentity): Promise<TelegramAuthorizationStatus> {
    return this.post<TelegramAuthorizationStatus>('status', identity, identity);
  }

  unlink(
    identity: TelegramIdentity,
    confirmed: boolean
  ): Promise<TelegramUnlinkResult> {
    return this.post<TelegramUnlinkResult>('unlink', identity, {
      ...identity,
      confirmed,
    });
  }

  async listOrders(
    identity: TelegramIdentity,
    cursor?: string
  ): Promise<OrderListResult> {
    const value = await this.post<unknown>('orders/list', identity, {
      telegram: {
        userId: identity.telegramUserId,
        chatId: identity.telegramChatId,
      },
      ...(cursor ? { cursor } : {}),
    });

    return parseOrderListResult(value);
  }

  async lookupOrder(
    identity: TelegramIdentity,
    orderNumber: string
  ): Promise<OrderLookupResult> {
    const value = await this.post<unknown>('orders/lookup', identity, {
      telegram: {
        userId: identity.telegramUserId,
        chatId: identity.telegramChatId,
      },
      orderNumber,
    });

    return parseOrderLookupResult(value);
  }

  async orderDetail(
    identity: TelegramIdentity,
    ref: string
  ): Promise<OrderDetailResult> {
    const value = await this.post<unknown>('orders/detail', identity, {
      telegram: {
        userId: identity.telegramUserId,
        chatId: identity.telegramChatId,
      },
      ref,
    });

    return parseOrderDetailResult(value);
  }

  async refreshOrder(
    identity: TelegramIdentity,
    ref: string
  ): Promise<OrderRefreshResult> {
    const value = await this.post<unknown>(
      'orders/refresh',
      identity,
      {
        telegram: {
          userId: identity.telegramUserId,
          chatId: identity.telegramChatId,
        },
        ref,
      },
      this.configuration.statusWriteTimeoutMs ?? 50_000
    );

    return parseOrderRefreshResult(value);
  }

  async orderNoteOptions(
    identity: TelegramIdentity,
    ref: string
  ): Promise<OrderNoteOptionsResult> {
    const value = await this.post<unknown>('orders/notes/options', identity, {
      telegram: {
        userId: identity.telegramUserId,
        chatId: identity.telegramChatId,
      },
      ref,
    });

    return parseOrderNoteOptionsResult(value);
  }

  async startOrderNote(
    identity: TelegramIdentity,
    ref: string,
    visibility: OrderNoteVisibility
  ): Promise<OrderNoteStartResult> {
    const value = await this.post<unknown>('orders/notes/start', identity, {
      telegram: {
        userId: identity.telegramUserId,
        chatId: identity.telegramChatId,
      },
      ref,
      visibility,
    });

    return parseOrderNoteStartResult(value);
  }

  async prepareOrderNote(
    identity: TelegramIdentity,
    ref: string,
    note: string
  ): Promise<OrderNotePrepareResult> {
    const value = await this.post<unknown>('orders/notes/prepare', identity, {
      telegram: {
        userId: identity.telegramUserId,
        chatId: identity.telegramChatId,
      },
      ref,
      note,
    });

    return parseOrderNotePrepareResult(value);
  }

  async cancelOrderNote(
    identity: TelegramIdentity,
    ref: string
  ): Promise<OrderNoteMutationResult> {
    const value = await this.post<unknown>('orders/notes/cancel', identity, {
      telegram: {
        userId: identity.telegramUserId,
        chatId: identity.telegramChatId,
      },
      ref,
    });

    return parseOrderNoteMutationResult(value);
  }

  async confirmOrderNote(
    identity: TelegramIdentity,
    ref: string
  ): Promise<OrderNoteMutationResult> {
    const value = await this.post<unknown>(
      'orders/notes/confirm',
      identity,
      {
        telegram: {
          userId: identity.telegramUserId,
          chatId: identity.telegramChatId,
        },
        ref,
      },
      this.configuration.statusWriteTimeoutMs ?? 50_000
    );

    return parseOrderNoteMutationResult(value);
  }

  async orderTransitions(
    identity: TelegramIdentity,
    ref: string
  ): Promise<OrderTransitionsResult> {
    const value = await this.post<unknown>('orders/transitions', identity, {
      telegram: {
        userId: identity.telegramUserId,
        chatId: identity.telegramChatId,
      },
      ref,
    });

    return parseOrderTransitionsResult(value);
  }

  async updateOrderStatus(
    identity: TelegramIdentity,
    ref: string,
    target: string
  ): Promise<OrderStatusUpdateResult> {
    const value = await this.post<unknown>(
      'orders/status',
      identity,
      {
        telegram: {
          userId: identity.telegramUserId,
          chatId: identity.telegramChatId,
        },
        ref,
        target,
      },
      this.configuration.statusWriteTimeoutMs ?? 50_000
    );

    return parseOrderStatusUpdateResult(value);
  }

  private async post<T>(
    path: string,
    identity: TelegramIdentity,
    body: object,
    timeoutMs = this.configuration.backendTimeoutMs ?? 5_000
  ): Promise<T> {
    const correlationId = `telegram-update-${identity.updateId}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.request(
        `${this.configuration.backendInternalUrl}/internal/telegram/${path}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-bot-api-key': this.configuration.internalApiKey,
            'x-correlation-id': correlationId,
            'x-telegram-update-id': identity.updateId,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        throw new BackendUnavailableError();
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof BackendUnavailableError) {
        throw error;
      }

      throw new BackendUnavailableError();
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseOrderListResult(value: unknown): OrderListResult {
  const record = requireRecord(value);
  const allowedStates = new Set([
    'OK',
    'NO_ACTIVE_STORE',
    'UNAUTHORIZED',
    'CONTEXT_CHANGED',
  ]);

  if (
    !allowedStates.has(String(record['state'])) ||
    !Array.isArray(record['orders']) ||
    !isNullableCallbackReference(record['nextCursor']) ||
    !isNullableCallbackReference(record['previousCursor']) ||
    !isFreshness(record['freshness'])
  ) {
    throw new MalformedBackendResponseError();
  }

  const orders = record['orders'].map(parseOrderSummary);

  return {
    state: record['state'] as OrderListResult['state'],
    orders,
    nextCursor: record['nextCursor'] as string | null,
    previousCursor: record['previousCursor'] as string | null,
    freshness: record['freshness'],
  };
}

function parseOrderDetailResult(value: unknown): OrderDetailResult {
  return parseOrderDetailLike(value, [
    'OK',
    'NOT_FOUND',
    'DELETED',
    'CONTEXT_CHANGED',
    'NO_ACTIVE_STORE',
    'UNAUTHORIZED',
  ]) as OrderDetailResult;
}

function parseOrderLookupResult(value: unknown): OrderLookupResult {
  return parseOrderDetailLike(value, [
    'OK',
    'NOT_FOUND',
    'DELETED',
    'CONTEXT_CHANGED',
    'NO_ACTIVE_STORE',
    'UNAUTHORIZED',
    'MALFORMED_ORDER_NUMBER',
    'AMBIGUOUS',
  ]) as OrderLookupResult;
}

function parseOrderRefreshResult(value: unknown): OrderRefreshResult {
  return parseOrderDetailLike(value, [
    'OK',
    'NOT_FOUND',
    'DELETED',
    'CONTEXT_CHANGED',
    'NO_ACTIVE_STORE',
    'UNAUTHORIZED',
    'RETRYABLE',
    'FAILED',
  ]) as OrderRefreshResult;
}

function parseOrderDetailLike(
  value: unknown,
  states: readonly string[]
): OrderDetailResult | OrderLookupResult | OrderRefreshResult {
  const record = requireRecord(value);
  const allowedStates = new Set(states);

  if (
    !allowedStates.has(String(record['state'])) ||
    !isFreshness(record['freshness']) ||
    (record['backCursor'] !== undefined &&
      !isCallbackReference(record['backCursor'])) ||
    (record['transitionsRef'] !== undefined &&
      !isCallbackReference(record['transitionsRef'], 'd')) ||
    (record['refreshRef'] !== undefined &&
      !isCallbackReference(record['refreshRef'], 'd')) ||
    (record['addNoteRef'] !== undefined &&
      !isCallbackReference(record['addNoteRef'], 'd'))
  ) {
    throw new MalformedBackendResponseError();
  }

  const state = record['state'] as OrderDetailResult['state'];
  const order =
    record['order'] === undefined
      ? undefined
      : parseOrderDetailPayload(record['order']);

  if (
    ((state === 'OK' || state === 'DELETED') && !order) ||
    (state === 'OK' && order?.remoteDeleted !== false) ||
    (state === 'DELETED' && order?.remoteDeleted !== true)
  ) {
    throw new MalformedBackendResponseError();
  }

  return {
    state,
    ...(order ? { order } : {}),
    ...(typeof record['backCursor'] === 'string'
      ? { backCursor: record['backCursor'] }
      : {}),
    ...(typeof record['transitionsRef'] === 'string'
      ? { transitionsRef: record['transitionsRef'] }
      : {}),
    ...(typeof record['refreshRef'] === 'string'
      ? { refreshRef: record['refreshRef'] }
      : {}),
    ...(typeof record['addNoteRef'] === 'string'
      ? { addNoteRef: record['addNoteRef'] }
      : {}),
    freshness: record['freshness'],
  };
}

function parseOrderNoteOptionsResult(value: unknown): OrderNoteOptionsResult {
  const record = parseOrderNoteBase(value);

  if (
    record['state'] === 'OK' &&
    (!isCallbackReference(record['ref'], 'd') ||
      !Array.isArray(record['visibilities']) ||
      !record['visibilities'].every(isNoteVisibility))
  ) {
    throw new MalformedBackendResponseError();
  }

  return record as unknown as OrderNoteOptionsResult;
}

function parseOrderNoteStartResult(value: unknown): OrderNoteStartResult {
  const record = parseOrderNoteBase(value);

  if (
    record['state'] === 'OK' &&
    (!isCallbackReference(record['inputRef'], 'i') ||
      !isCallbackReference(record['detailRef'], 'd') ||
      !isNoteVisibility(record['visibility']) ||
      typeof record['maxLength'] !== 'number' ||
      !Number.isSafeInteger(record['maxLength']))
  ) {
    throw new MalformedBackendResponseError();
  }

  return record as unknown as OrderNoteStartResult;
}

function parseOrderNotePrepareResult(value: unknown): OrderNotePrepareResult {
  const record = parseOrderNoteBase(value);

  if (
    record['state'] === 'OK' &&
    (!isCallbackReference(record['confirmRef'], 'c') ||
      !isCallbackReference(record['detailRef'], 'd') ||
      !isNoteVisibility(record['visibility']) ||
      !isString(record['preview']))
  ) {
    throw new MalformedBackendResponseError();
  }

  return record as unknown as OrderNotePrepareResult;
}

function parseOrderNoteMutationResult(value: unknown): OrderNoteMutationResult {
  const record = parseOrderNoteBase(value);

  if (
    (record['detailRef'] !== undefined &&
      !isCallbackReference(record['detailRef'], 'd')) ||
    (record['visibility'] !== undefined &&
      !isNoteVisibility(record['visibility'])) ||
    (record['orderNumber'] !== undefined && !isString(record['orderNumber']))
  ) {
    throw new MalformedBackendResponseError();
  }

  return record as unknown as OrderNoteMutationResult;
}

function parseOrderNoteBase(value: unknown): Record<string, unknown> {
  const record = requireRecord(value);
  const states = new Set([
    'OK',
    'CANCELLED',
    'INVALID_NOTE',
    'IN_PROGRESS',
    'AMBIGUOUS',
    'RETRYABLE',
    'FAILED',
    'NOT_FOUND',
    'DELETED',
    'NO_ACTIVE_STORE',
    'UNAUTHORIZED',
    'CONTEXT_CHANGED',
    'FORBIDDEN_ROLE',
    'EXPIRED_REF',
  ]);

  if (!states.has(String(record['state']))) {
    throw new MalformedBackendResponseError();
  }

  return record;
}

function parseOrderTransitionsResult(value: unknown): OrderTransitionsResult {
  const record = requireRecord(value);
  const allowedStates = new Set([
    'OK',
    'NOT_FOUND',
    'DELETED',
    'NO_ACTIVE_STORE',
    'UNAUTHORIZED',
    'CONTEXT_CHANGED',
    'FORBIDDEN_ROLE',
  ]);

  if (!allowedStates.has(String(record['state']))) {
    throw new MalformedBackendResponseError();
  }

  if (
    record['state'] === 'OK' &&
    (!isCallbackReference(record['ref'], 's') ||
      !isString(record['currentStatus']) ||
      !Array.isArray(record['targets']) ||
      !record['targets'].every(isStatus))
  ) {
    throw new MalformedBackendResponseError();
  }

  return record as unknown as OrderTransitionsResult;
}

function parseOrderStatusUpdateResult(value: unknown): OrderStatusUpdateResult {
  const record = requireRecord(value);
  const allowedStates = new Set([
    'OK',
    'NO_OP',
    'RETRYABLE',
    'FAILED',
    'NOT_FOUND',
    'DELETED',
    'NO_ACTIVE_STORE',
    'UNAUTHORIZED',
    'CONTEXT_CHANGED',
    'FORBIDDEN_ROLE',
    'INVALID_TARGET',
    'EXPIRED_REF',
  ]);

  if (
    !allowedStates.has(String(record['state'])) ||
    (record['backCursor'] !== undefined &&
      !isCallbackReference(record['backCursor'])) ||
    (record['freshness'] !== undefined && !isFreshness(record['freshness']))
  ) {
    throw new MalformedBackendResponseError();
  }

  const state = record['state'] as OrderStatusUpdateResult['state'];
  const order =
    record['order'] === undefined
      ? undefined
      : parseOrderDetailPayload(record['order']);

  if (
    (state === 'OK' || state === 'NO_OP') &&
    (!order || !record['freshness'])
  ) {
    throw new MalformedBackendResponseError();
  }

  return {
    state,
    ...(order ? { order } : {}),
    ...(typeof record['backCursor'] === 'string'
      ? { backCursor: record['backCursor'] }
      : {}),
    ...(record['freshness']
      ? { freshness: record['freshness'] as OrderFreshness }
      : {}),
  };
}

function parseOrderSummary(value: unknown): OrderSummary {
  const record = requireRecord(value);

  if (
    !isCallbackReference(record['ref'], 'd') ||
    !isString(record['orderNumber']) ||
    !isString(record['status']) ||
    !isString(record['currency']) ||
    !isString(record['total']) ||
    !isString(record['customerDisplayName']) ||
    !isIsoDate(record['wcCreatedAt']) ||
    typeof record['remoteDeleted'] !== 'boolean'
  ) {
    throw new MalformedBackendResponseError();
  }

  return record as unknown as OrderSummary;
}

function parseOrderDetailPayload(value: unknown): OrderDetailPayload {
  const record = requireRecord(value);

  if (
    !isString(record['orderNumber']) ||
    !isString(record['status']) ||
    !isString(record['customerDisplayName']) ||
    typeof record['remoteDeleted'] !== 'boolean'
  ) {
    throw new MalformedBackendResponseError();
  }

  if (!record['remoteDeleted']) {
    if (
      !isString(record['currency']) ||
      !isIsoDate(record['wcCreatedAt']) ||
      !isIsoDate(record['wcModifiedAt']) ||
      !Array.isArray(record['lineItems']) ||
      !record['lineItems'].every(isOrderLineItem) ||
      !isScalarRecord(record['totals']) ||
      (record['payment'] !== undefined &&
        !isPaymentContext(record['payment'])) ||
      (record['shipping'] !== undefined &&
        !isShippingContext(record['shipping']))
    ) {
      throw new MalformedBackendResponseError();
    }
  }

  return record as unknown as OrderDetailPayload;
}

function isPaymentContext(value: unknown): boolean {
  const record = asRecord(value);

  return Boolean(
    record &&
    (record['method'] === null || isString(record['method'])) &&
    typeof record['paid'] === 'boolean'
  );
}

function isShippingContext(value: unknown): boolean {
  const record = asRecord(value);

  return Boolean(
    record &&
    Array.isArray(record['methods']) &&
    record['methods'].every(isString) &&
    Array.isArray(record['addressLines']) &&
    record['addressLines'].every(isString)
  );
}

function isOrderLineItem(value: unknown): boolean {
  const record = asRecord(value);

  return Boolean(
    record &&
    isString(record['name']) &&
    (typeof record['quantity'] === 'string' ||
      typeof record['quantity'] === 'number') &&
    isString(record['total'])
  );
}

function isFreshness(value: unknown): value is OrderFreshness {
  const record = asRecord(value);

  return Boolean(
    record &&
    isIsoDate(record['asOf']) &&
    typeof record['delayed'] === 'boolean'
  );
}

function isScalarRecord(value: unknown): boolean {
  const record = asRecord(value);

  return Boolean(
    record &&
    Object.values(record).every(
      (item) => typeof item === 'string' || typeof item === 'number'
    )
  );
}

function isNullableCallbackReference(value: unknown): boolean {
  return value === null || isCallbackReference(value, 'p');
}

function isCallbackReference(
  value: unknown,
  prefix: 'p' | 'd' | 's' | 'i' | 'c' = 'p'
): value is string {
  return (
    typeof value === 'string' &&
    new RegExp(`^${prefix}\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]{16}$`).test(
      value
    ) &&
    value.length <= 64
  );
}

function isNoteVisibility(value: unknown): value is OrderNoteVisibility {
  return value === 'INTERNAL' || value === 'CUSTOMER';
}

function isStatus(value: unknown): boolean {
  return typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value);
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function requireRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);

  if (!record) {
    throw new MalformedBackendResponseError();
  }

  return record;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
