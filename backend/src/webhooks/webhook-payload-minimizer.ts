import { Prisma } from '@prisma/client';

const ORDER_FIELDS = [
  'id',
  'number',
  'status',
  'currency',
  'discount_total',
  'discount_tax',
  'shipping_total',
  'shipping_tax',
  'cart_tax',
  'total',
  'total_tax',
  'payment_method',
  'payment_method_title',
  'date_paid_gmt',
  'date_paid',
  'date_created_gmt',
  'date_modified_gmt',
] as const;
const BILLING_FIELDS = ['first_name', 'last_name', 'company'] as const;
const SHIPPING_FIELDS = [
  'company',
  'address_1',
  'address_2',
  'city',
  'state',
  'postcode',
  'country',
] as const;
const LINE_ITEM_FIELDS = ['name', 'quantity', 'total'] as const;
const SHIPPING_LINE_FIELDS = ['method_id', 'method_title'] as const;
const INVENTORY_FIELDS = [
  'id',
  'parent_id',
  'type',
  'manage_stock',
  'stock_status',
  'stock_quantity',
  'sku',
  'name',
  'date_modified_gmt',
  'variations',
] as const;
const ATTRIBUTE_FIELDS = ['name', 'option'] as const;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function scalar(value: unknown): string | number | boolean | null | undefined {
  return value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
    ? value
    : undefined;
}

function pick(source: JsonRecord, fields: readonly string[]): JsonRecord {
  const result: JsonRecord = {};

  for (const field of fields) {
    const value = scalar(source[field]);

    if (value !== undefined) {
      result[field] = value;
    }
  }

  return result;
}

function pickedRecord(value: unknown, fields: readonly string[]): JsonRecord {
  return pick(record(value) ?? {}, fields);
}

function pickedArray(value: unknown, fields: readonly string[]): JsonRecord[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const source = record(item);
        return source ? [pick(source, fields)] : [];
      })
    : [];
}

/** Data persisted after HMAC verification; this is also used for old-row scrubbing. */
export function minimizeWebhookPayload(
  topic: string,
  value: unknown
): Prisma.InputJsonObject {
  const source = record(value);

  if (!source) {
    return {};
  }

  if (topic.startsWith('order.')) {
    const result = pick(source, ORDER_FIELDS);

    if (topic !== 'order.deleted') {
      result['billing'] = pickedRecord(source['billing'], BILLING_FIELDS);
      result['shipping'] = pickedRecord(source['shipping'], SHIPPING_FIELDS);
      result['line_items'] = pickedArray(
        source['line_items'],
        LINE_ITEM_FIELDS
      );
      result['shipping_lines'] = pickedArray(
        source['shipping_lines'],
        SHIPPING_LINE_FIELDS
      );
    }

    return result as Prisma.InputJsonObject;
  }

  if (topic.startsWith('product.') || topic.startsWith('variation.')) {
    const result = pick(source, INVENTORY_FIELDS);
    result['attributes'] = pickedArray(source['attributes'], ATTRIBUTE_FIELDS);

    if (Array.isArray(source['variations'])) {
      result['variations'] = source['variations'].flatMap((item) => {
        const value = scalar(item);
        return typeof value === 'number' || typeof value === 'string'
          ? [value]
          : [];
      });
    }

    return result as Prisma.InputJsonObject;
  }

  return pick(source, ['id']) as Prisma.InputJsonObject;
}
