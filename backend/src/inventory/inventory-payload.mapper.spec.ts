import { describe, expect, it } from '@jest/globals';
import {
  InventoryAlertClassification,
  InventoryItemKind,
} from '@prisma/client';

import {
  classifyInventoryItem,
  mapWooCommerceInventoryItem,
  productRequiresVariationScan,
} from './inventory-payload.mapper';

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    parent_id: 0,
    type: 'simple',
    name: 'Test product',
    sku: 'SKU-101',
    manage_stock: true,
    stock_quantity: 5,
    stock_status: 'instock',
    date_modified_gmt: '2026-09-01T08:00:00',
    attributes: [],
    variations: [],
    ...overrides,
  };
}

describe('M19 WooCommerce inventory mapping and classification', () => {
  it('uses the Store threshold at threshold-1, threshold, and threshold+1', () => {
    expect(classifyInventoryItem(true, '4', 'instock', 5)).toBe(
      InventoryAlertClassification.LOW_STOCK
    );
    expect(classifyInventoryItem(true, '5', 'onbackorder', 5)).toBe(
      InventoryAlertClassification.LOW_STOCK
    );
    expect(classifyInventoryItem(true, '6', 'instock', 5)).toBe(
      InventoryAlertClassification.HEALTHY
    );
  });

  it('keeps explicit WooCommerce outofstock authoritative with a null threshold', () => {
    expect(classifyInventoryItem(true, '100', 'outofstock', null)).toBe(
      InventoryAlertClassification.OUT_OF_STOCK
    );
    expect(classifyInventoryItem(true, '0', 'instock', null)).toBe(
      InventoryAlertClassification.HEALTHY
    );
    expect(classifyInventoryItem(false, null, 'outofstock', null)).toBe(
      InventoryAlertClassification.OUT_OF_STOCK
    );
  });

  it('projects only narrow stock fields for a managed product', () => {
    const mapped = mapWooCommerceInventoryItem(
      product({ description: 'must not be projected', price: '99.00' })
    );

    expect(mapped).toMatchObject({
      wcItemId: '101',
      parentWcProductId: null,
      kind: InventoryItemKind.PRODUCT,
      displayName: 'Test product',
      sku: 'SKU-101',
      managesStock: true,
      stockQuantity: '5',
      stockStatus: 'instock',
      active: true,
    });
    expect(mapped.projectionFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(mapped).not.toHaveProperty('description');
    expect(mapped).not.toHaveProperty('price');
  });

  it('keeps a managed product with WooCommerce null stock quantity restart-safe', () => {
    const mapped = mapWooCommerceInventoryItem(
      product({ manage_stock: true, stock_quantity: null })
    );

    expect(mapped).toMatchObject({
      managesStock: true,
      stockQuantity: null,
      stockStatus: 'instock',
      active: true,
    });
    expect(
      classifyInventoryItem(
        mapped.managesStock,
        mapped.stockQuantity,
        mapped.stockStatus,
        5
      )
    ).toBe(InventoryAlertClassification.HEALTHY);
  });

  it('uses SKU when WooCommerce returns the valid empty product name condition', () => {
    expect(mapWooCommerceInventoryItem(product({ name: '' }))).toMatchObject({
      wcItemId: '101',
      displayName: 'SKU-101',
      sku: 'SKU-101',
    });
  });

  it('uses a stable generic product name when both Woo name and SKU are unusable', () => {
    expect(
      mapWooCommerceInventoryItem(product({ name: ' \t ', sku: '' }))
    ).toMatchObject({
      wcItemId: '101',
      displayName: 'Unnamed product',
      sku: null,
    });
  });

  it.each([undefined, null, ' \t ', 101])(
    'keeps an otherwise valid product projectable for unusable name value %p',
    (name) => {
      expect(
        mapWooCommerceInventoryItem(product({ name, sku: '' }))
      ).toMatchObject({
        wcItemId: '101',
        displayName: 'Unnamed product',
      });
    }
  );

  it('represents independently managed variations with bounded context', () => {
    const mapped = mapWooCommerceInventoryItem(
      product({
        id: 202,
        parent_id: 101,
        type: 'variation',
        name: 'Test product - Blue / XL',
        manage_stock: true,
        stock_quantity: 2,
        attributes: [
          { name: 'Color', option: 'Blue' },
          { name: 'Size', option: 'XL' },
        ],
      })
    );

    expect(mapped).toMatchObject({
      wcItemId: '202',
      parentWcProductId: '101',
      kind: InventoryItemKind.VARIATION,
      managesStock: true,
      stockQuantity: '2',
      active: true,
      variationContext: [
        { name: 'Color', option: 'Blue' },
        { name: 'Size', option: 'XL' },
      ],
    });
  });

  it('uses a stable generic variation name when Woo name and SKU are unusable', () => {
    expect(
      mapWooCommerceInventoryItem(
        product({
          id: 202,
          parent_id: 101,
          type: 'variation',
          name: '',
          sku: ' \n ',
        })
      )
    ).toMatchObject({
      wcItemId: '202',
      parentWcProductId: '101',
      kind: InventoryItemKind.VARIATION,
      displayName: 'Unnamed variation',
      sku: null,
    });
  });

  it('does not create a separate stock pool for a parent-inheriting variation', () => {
    const mapped = mapWooCommerceInventoryItem(
      product({
        id: 202,
        parent_id: 101,
        type: 'variation',
        manage_stock: 'parent',
        stock_quantity: null,
        stock_status: 'outofstock',
      })
    );

    expect(mapped).toMatchObject({
      kind: InventoryItemKind.VARIATION,
      managesStock: false,
      stockQuantity: null,
      active: false,
    });
  });

  it('keeps an unmanaged simple product visible when WooCommerce says outofstock', () => {
    expect(
      mapWooCommerceInventoryItem(
        product({
          manage_stock: false,
          stock_quantity: null,
          stock_status: 'outofstock',
        })
      )
    ).toMatchObject({ active: true, managesStock: false, stockQuantity: null });
  });

  it('keeps an unmanaged explicit-out variation without treating parent inheritance as stock', () => {
    expect(
      mapWooCommerceInventoryItem(
        product({
          id: 202,
          parent_id: 101,
          type: 'variation',
          manage_stock: false,
          stock_quantity: null,
          stock_status: 'outofstock',
        })
      )
    ).toMatchObject({
      kind: InventoryItemKind.VARIATION,
      active: true,
      managesStock: false,
      stockQuantity: null,
    });
  });

  it('detects variable products requiring bounded variation pages', () => {
    expect(
      productRequiresVariationScan(
        product({ type: 'variable', variations: [201, 202] })
      )
    ).toBe(true);
    expect(productRequiresVariationScan(product())).toBe(false);
  });
});
