import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';

const GMT_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z?$/;
const WC_ORDER_ID_PATTERN = /^[1-9]\d{0,31}$/;
const TOTAL_FIELDS = [
  'discount_total',
  'discount_tax',
  'shipping_total',
  'shipping_tax',
  'cart_tax',
  'total',
  'total_tax',
] as const;

export interface OrderProjection {
  wcOrderId: string;
  orderNumber: string;
  status: string;
  currency: string;
  totals: Prisma.InputJsonObject;
  customerSnapshot: Prisma.InputJsonObject;
  lineItemsSnapshot: Prisma.InputJsonArray;
  paymentSnapshot: Prisma.InputJsonObject;
  shippingLinesSnapshot: Prisma.InputJsonArray;
  wcCreatedAt: Date;
  wcModifiedAt: Date;
  remoteDeletedAt: Date | null;
  projectionFingerprint: string;
}

export class OrderPayloadMappingError extends Error {
  constructor(
    readonly code: string,
    readonly wcOrderId?: string
  ) {
    super(code);
    this.name = 'OrderPayloadMappingError';
  }
}

export function readWooCommerceOrderId(payload: unknown): string {
  const record = requireRecord(payload, 'malformed-order-payload');
  const value = record['id'];
  const normalized =
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : typeof value === 'string'
        ? value
        : '';

  if (!WC_ORDER_ID_PATTERN.test(normalized)) {
    throw new OrderPayloadMappingError('malformed-order-identity');
  }

  return normalized;
}

export function mapWooCommerceOrder(payload: unknown): OrderProjection {
  const record = requireRecord(payload, 'malformed-order-payload');
  const wcOrderId = readWooCommerceOrderId(record);

  try {
    const totals: Record<string, string | number> = {};

    for (const field of TOTAL_FIELDS) {
      const value = record[field];

      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new OrderPayloadMappingError('malformed-order-totals', wcOrderId);
      }

      totals[field] = value;
    }

    const billing = requireRecord(
      record['billing'],
      'malformed-order-customer',
      wcOrderId
    );
    const shipping = requireRecord(
      record['shipping'],
      'malformed-order-customer',
      wcOrderId
    );
    const lineItems = record['line_items'];
    const shippingLines = record['shipping_lines'] ?? [];

    if (!Array.isArray(lineItems)) {
      throw new OrderPayloadMappingError(
        'malformed-order-line-items',
        wcOrderId
      );
    }

    if (!Array.isArray(shippingLines)) {
      throw new OrderPayloadMappingError(
        'malformed-order-shipping-lines',
        wcOrderId
      );
    }

    const projection: Omit<OrderProjection, 'projectionFingerprint'> = {
      wcOrderId,
      orderNumber: requireDisplayString(
        record['number'],
        'malformed-order-number',
        wcOrderId
      ),
      status: requireString(
        record['status'],
        'malformed-order-status',
        wcOrderId
      ),
      currency: requireString(
        record['currency'],
        'malformed-order-currency',
        wcOrderId
      ),
      totals: canonicalizeJson(totals) as Prisma.InputJsonObject,
      customerSnapshot: canonicalizeJson({
        customer_id: normalizeCustomerId(record['customer_id']),
        billing,
        shipping,
      }) as Prisma.InputJsonObject,
      lineItemsSnapshot: canonicalizeJson(lineItems) as Prisma.InputJsonArray,
      paymentSnapshot: canonicalizeJson({
        method: normalizeOptionalString(record['payment_method'], wcOrderId),
        method_title: normalizeOptionalString(
          record['payment_method_title'],
          wcOrderId
        ),
        paid: hasPaidDate(
          record['date_paid_gmt'] ?? record['date_paid'],
          wcOrderId
        ),
      }) as Prisma.InputJsonObject,
      shippingLinesSnapshot: canonicalizeJson(
        shippingLines.map((line) => {
          const shippingLine = requireRecord(
            line,
            'malformed-order-shipping-lines',
            wcOrderId
          );

          return {
            method_id: normalizeOptionalString(
              shippingLine['method_id'],
              wcOrderId
            ),
            method_title: normalizeOptionalString(
              shippingLine['method_title'],
              wcOrderId
            ),
          };
        })
      ) as Prisma.InputJsonArray,
      wcCreatedAt: requireGmtDate(
        record['date_created_gmt'],
        'malformed-order-created-at',
        wcOrderId
      ),
      wcModifiedAt: requireGmtDate(
        record['date_modified_gmt'],
        'unreliable-order-modified-at',
        wcOrderId
      ),
      remoteDeletedAt: null,
    };

    return {
      ...projection,
      projectionFingerprint: orderProjectionFingerprint(projection),
    };
  } catch (error: unknown) {
    if (error instanceof OrderPayloadMappingError) {
      throw error;
    }

    throw new OrderPayloadMappingError('malformed-order-payload', wcOrderId);
  }
}

export function orderProjectionFingerprint(
  projection: Omit<OrderProjection, 'projectionFingerprint'>
): string {
  const canonical = canonicalSerialize({
    wcOrderId: projection.wcOrderId,
    orderNumber: projection.orderNumber,
    status: projection.status,
    currency: projection.currency,
    totals: projection.totals,
    customerSnapshot: projection.customerSnapshot,
    lineItemsSnapshot: projection.lineItemsSnapshot,
    paymentSnapshot: projection.paymentSnapshot,
    shippingLinesSnapshot: projection.shippingLinesSnapshot,
    wcCreatedAt: projection.wcCreatedAt.toISOString(),
    wcModifiedAt: projection.wcModifiedAt.toISOString(),
    remoteDeletedAt: projection.remoteDeletedAt?.toISOString() ?? null,
  });

  return createHash('sha256').update(canonical).digest('hex');
}

export function withRemoteDeletedAt(
  projection: OrderProjection,
  remoteDeletedAt: Date | null
): OrderProjection {
  const next = {
    ...projection,
    remoteDeletedAt,
  };

  return {
    ...next,
    projectionFingerprint: orderProjectionFingerprint(next),
  };
}

export function canonicalSerialize(value: unknown): string {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'string' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new OrderPayloadMappingError('malformed-order-json');
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalSerialize(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();

    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`)
      .join(',')}}`;
  }

  throw new OrderPayloadMappingError('malformed-order-json');
}

function canonicalizeJson(value: unknown): Prisma.InputJsonValue | null {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new OrderPayloadMappingError('malformed-order-json');
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizeJson(item)])
    );
  }

  throw new OrderPayloadMappingError('malformed-order-json');
}

function requireRecord(
  value: unknown,
  code: string,
  wcOrderId?: string
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrderPayloadMappingError(code, wcOrderId);
  }

  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  code: string,
  wcOrderId: string
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OrderPayloadMappingError(code, wcOrderId);
  }

  return value;
}

function requireDisplayString(
  value: unknown,
  code: string,
  wcOrderId: string
): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }

  return requireString(value, code, wcOrderId);
}

function requireGmtDate(value: unknown, code: string, wcOrderId: string): Date {
  if (typeof value !== 'string' || !GMT_DATE_PATTERN.test(value)) {
    throw new OrderPayloadMappingError(code, wcOrderId);
  }

  const parsed = new Date(value.endsWith('Z') ? value : `${value}Z`);

  if (Number.isNaN(parsed.getTime())) {
    throw new OrderPayloadMappingError(code, wcOrderId);
  }

  return parsed;
}

function normalizeCustomerId(value: unknown): Prisma.InputJsonValue | null {
  if (
    value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'string' && /^\d+$/.test(value))
  ) {
    return value;
  }

  throw new OrderPayloadMappingError('malformed-order-customer');
}

function normalizeOptionalString(
  value: unknown,
  wcOrderId: string
): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new OrderPayloadMappingError('malformed-order-context', wcOrderId);
  }

  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function hasPaidDate(value: unknown, wcOrderId: string): boolean {
  if (value === null || value === undefined || value === '') {
    return false;
  }

  if (typeof value !== 'string') {
    throw new OrderPayloadMappingError('malformed-order-payment', wcOrderId);
  }

  return true;
}
