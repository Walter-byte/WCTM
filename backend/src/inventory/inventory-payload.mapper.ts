import {
  InventoryAlertClassification,
  InventoryItemKind,
} from '@prisma/client';
import { createHash } from 'node:crypto';

const GMT_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z?$/;
const WC_ITEM_ID_PATTERN = /^[1-9]\d{0,31}$/;
const DECIMAL_PATTERN = /^-?\d{1,14}(?:\.\d{1,6})?$/;
const STOCK_STATUSES = new Set(['instock', 'outofstock', 'onbackorder']);

export interface InventoryProjection {
  wcItemId: string;
  parentWcProductId: string | null;
  kind: InventoryItemKind;
  displayName: string;
  sku: string | null;
  variationContext: Array<{ name: string; option: string }>;
  managesStock: boolean;
  stockQuantity: string | null;
  stockStatus: string;
  wcModifiedAt: Date;
  active: boolean;
  projectionFingerprint: string;
}

export class InventoryPayloadMappingError extends Error {
  constructor(
    readonly code: string,
    readonly wcItemId?: string,
    readonly parentWcProductId?: string
  ) {
    super(code);
    this.name = 'InventoryPayloadMappingError';
  }
}

export function readWooCommerceInventoryItemId(payload: unknown): string {
  const record = requireRecord(payload, 'malformed-inventory-payload');
  return normalizeIdentifier(record['id'], 'malformed-inventory-identity');
}

export function readWooCommerceParentProductId(
  payload: unknown
): string | undefined {
  const record = requireRecord(payload, 'malformed-inventory-payload');
  const value = record['parent_id'];

  if (value === undefined || value === null || value === 0 || value === '0') {
    return undefined;
  }

  return normalizeIdentifier(value, 'malformed-inventory-parent-identity');
}

export function readWooCommerceInventoryModifiedAt(payload: unknown): Date {
  const record = requireRecord(payload, 'malformed-inventory-payload');
  const wcItemId = readWooCommerceInventoryItemId(record);
  let parentWcProductId: string | undefined;

  try {
    parentWcProductId = readWooCommerceParentProductId(record);
  } catch {
    // The item identity still permits a bounded authoritative read even when
    // the optional parent hint is malformed.
  }

  return requireGmtDate(
    record['date_modified_gmt'],
    wcItemId,
    parentWcProductId
  );
}

export function productRequiresVariationScan(payload: unknown): boolean {
  const record = requireRecord(payload, 'malformed-inventory-payload');
  const variations = record['variations'];

  return (
    record['type'] === 'variable' &&
    Array.isArray(variations) &&
    variations.some((value) => {
      try {
        normalizeIdentifier(value, 'malformed-inventory-variation-identity');
        return true;
      } catch {
        return false;
      }
    })
  );
}

export function mapWooCommerceInventoryItem(
  payload: unknown
): InventoryProjection {
  const record = requireRecord(payload, 'malformed-inventory-payload');
  const wcItemId = readWooCommerceInventoryItemId(record);
  const parentWcProductId = readWooCommerceParentProductId(record) ?? null;

  try {
    const type = requireString(
      record['type'],
      'malformed-inventory-type',
      wcItemId,
      parentWcProductId ?? undefined
    );
    const kind =
      parentWcProductId !== null || type === 'variation'
        ? InventoryItemKind.VARIATION
        : InventoryItemKind.PRODUCT;

    if (kind === InventoryItemKind.VARIATION && !parentWcProductId) {
      throw new InventoryPayloadMappingError(
        'malformed-inventory-parent-identity',
        wcItemId
      );
    }

    const inheritsParentStock = record['manage_stock'] === 'parent';
    const managesStock = normalizeManageStock(
      record['manage_stock'],
      wcItemId,
      parentWcProductId ?? undefined
    );
    const stockStatus = requireString(
      record['stock_status'],
      'malformed-inventory-stock-status',
      wcItemId,
      parentWcProductId ?? undefined
    );

    if (!STOCK_STATUSES.has(stockStatus)) {
      throw new InventoryPayloadMappingError(
        'malformed-inventory-stock-status',
        wcItemId,
        parentWcProductId ?? undefined
      );
    }

    const stockQuantity = managesStock
      ? normalizeStockQuantity(
          record['stock_quantity'],
          wcItemId,
          parentWcProductId ?? undefined
        )
      : null;
    const active =
      managesStock ||
      (!inheritsParentStock &&
        stockStatus === 'outofstock' &&
        (kind === InventoryItemKind.VARIATION || type !== 'variable'));
    const projection: Omit<InventoryProjection, 'projectionFingerprint'> = {
      wcItemId,
      parentWcProductId,
      kind,
      displayName: safeDisplay(
        record['name'],
        255,
        'malformed-inventory-name',
        wcItemId,
        parentWcProductId ?? undefined
      ),
      sku: optionalDisplay(record['sku'], 191),
      variationContext:
        kind === InventoryItemKind.VARIATION
          ? mapVariationContext(record['attributes'])
          : [],
      managesStock,
      stockQuantity,
      stockStatus,
      wcModifiedAt: requireGmtDate(
        record['date_modified_gmt'],
        wcItemId,
        parentWcProductId ?? undefined
      ),
      active,
    };

    return {
      ...projection,
      projectionFingerprint: inventoryProjectionFingerprint(projection),
    };
  } catch (error: unknown) {
    if (error instanceof InventoryPayloadMappingError) {
      throw error;
    }

    throw new InventoryPayloadMappingError(
      'malformed-inventory-payload',
      wcItemId,
      parentWcProductId ?? undefined
    );
  }
}

export function classifyInventoryItem(
  managesStock: boolean,
  stockQuantity: string | null,
  stockStatus: string,
  lowStockThreshold: number | null
): InventoryAlertClassification {
  if (stockStatus === 'outofstock') {
    return InventoryAlertClassification.OUT_OF_STOCK;
  }

  if (
    managesStock &&
    stockQuantity !== null &&
    lowStockThreshold !== null &&
    Number(stockQuantity) <= lowStockThreshold
  ) {
    return InventoryAlertClassification.LOW_STOCK;
  }

  return InventoryAlertClassification.HEALTHY;
}

export function inventoryProjectionFingerprint(
  projection: Omit<InventoryProjection, 'projectionFingerprint'>
): string {
  const canonical = JSON.stringify({
    active: projection.active,
    displayName: projection.displayName,
    kind: projection.kind,
    managesStock: projection.managesStock,
    parentWcProductId: projection.parentWcProductId,
    sku: projection.sku,
    stockQuantity: projection.stockQuantity,
    stockStatus: projection.stockStatus,
    variationContext: projection.variationContext,
    wcItemId: projection.wcItemId,
    wcModifiedAt: projection.wcModifiedAt.toISOString(),
  });

  return createHash('sha256').update(canonical).digest('hex');
}

function normalizeIdentifier(value: unknown, code: string): string {
  const normalized =
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : typeof value === 'string'
        ? value
        : '';

  if (!WC_ITEM_ID_PATTERN.test(normalized)) {
    throw new InventoryPayloadMappingError(code);
  }

  return normalized;
}

function normalizeManageStock(
  value: unknown,
  wcItemId: string,
  parentWcProductId?: string
): boolean {
  if (value === true) {
    return true;
  }

  if (value === false || value === 'parent') {
    return false;
  }

  throw new InventoryPayloadMappingError(
    'malformed-inventory-stock-ownership',
    wcItemId,
    parentWcProductId
  );
}

function normalizeStockQuantity(
  value: unknown,
  wcItemId: string,
  parentWcProductId?: string
): string | null {
  // WooCommerce can legitimately expose a managed-stock item whose persisted
  // quantity is unset (for example after Quick Edit leaves the quantity
  // blank). The stock status remains authoritative, while a missing numeric
  // quantity cannot participate in WCTM threshold classification.
  if (value === null) {
    return null;
  }

  const candidate =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';

  if (!DECIMAL_PATTERN.test(candidate)) {
    throw new InventoryPayloadMappingError(
      'malformed-inventory-stock-quantity',
      wcItemId,
      parentWcProductId
    );
  }

  const number = Number(candidate);

  if (!Number.isFinite(number)) {
    throw new InventoryPayloadMappingError(
      'malformed-inventory-stock-quantity',
      wcItemId,
      parentWcProductId
    );
  }

  return number === 0 ? '0' : String(number);
}

function mapVariationContext(
  value: unknown
): Array<{ name: string; option: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, 8).flatMap((candidate) => {
    if (candidate === null || typeof candidate !== 'object') {
      return [];
    }

    const attribute = candidate as Record<string, unknown>;
    const name = optionalDisplay(attribute['name'], 80);
    const option = optionalDisplay(attribute['option'], 120);

    return name && option ? [{ name, option }] : [];
  });
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InventoryPayloadMappingError(code);
  }

  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  code: string,
  wcItemId: string,
  parentWcProductId?: string
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InventoryPayloadMappingError(code, wcItemId, parentWcProductId);
  }

  return value.trim();
}

function safeDisplay(
  value: unknown,
  maximumLength: number,
  code: string,
  wcItemId: string,
  parentWcProductId?: string
): string {
  const normalized = optionalDisplay(value, maximumLength);

  if (!normalized) {
    throw new InventoryPayloadMappingError(code, wcItemId, parentWcProductId);
  }

  return normalized;
}

function optionalDisplay(value: unknown, maximumLength: number): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = Array.from(value.replace(/\s+/g, ' '))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .trim()
    .slice(0, maximumLength);

  return normalized || null;
}

function requireGmtDate(
  value: unknown,
  wcItemId: string,
  parentWcProductId?: string
): Date {
  if (typeof value !== 'string' || !GMT_DATE_PATTERN.test(value)) {
    throw new InventoryPayloadMappingError(
      'unreliable-inventory-modified-at',
      wcItemId,
      parentWcProductId
    );
  }

  const normalized = value.endsWith('Z') ? value : `${value}Z`;
  const date = new Date(normalized);

  if (Number.isNaN(date.getTime())) {
    throw new InventoryPayloadMappingError(
      'unreliable-inventory-modified-at',
      wcItemId,
      parentWcProductId
    );
  }

  return date;
}
