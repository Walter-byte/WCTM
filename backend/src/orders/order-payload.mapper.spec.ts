import { describe, expect, it } from '@jest/globals';

import {
  canonicalSerialize,
  mapWooCommerceOrder,
  orderProjectionFingerprint,
} from './order-payload.mapper';

function orderPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    number: 'WC-101',
    status: 'processing',
    currency: 'USD',
    discount_total: '1.00',
    discount_tax: '0.10',
    shipping_total: '5.00',
    shipping_tax: '0.50',
    cart_tax: '2.00',
    total: '26.00',
    total_tax: '2.60',
    customer_id: 7,
    billing: { last_name: 'Doe', first_name: 'Jane' },
    shipping: { country: 'US', city: 'Austin' },
    payment_method: 'cod',
    payment_method_title: 'Cash on delivery',
    date_paid_gmt: null,
    shipping_lines: [{ method_id: 'flat_rate', method_title: 'Flat rate' }],
    line_items: [{ quantity: 2, name: 'Widget', id: 11, total: '20.00' }],
    date_created_gmt: '2026-07-23T10:00:00',
    date_modified_gmt: '2026-07-23T10:05:00',
    ...overrides,
  };
}

describe('WooCommerce order payload mapping', () => {
  it('maps the approved order snapshot fields', () => {
    const mapped = mapWooCommerceOrder(orderPayload());

    expect(mapped).toMatchObject({
      wcOrderId: '101',
      orderNumber: 'WC-101',
      status: 'processing',
      currency: 'USD',
      totals: {
        total: '26.00',
        total_tax: '2.60',
      },
      customerSnapshot: {
        customer_id: 7,
      },
      paymentSnapshot: {
        method: 'cod',
        method_title: 'Cash on delivery',
        paid: false,
      },
      shippingLinesSnapshot: [
        { method_id: 'flat_rate', method_title: 'Flat rate' },
      ],
      remoteDeletedAt: null,
    });
    expect(mapped.lineItemsSnapshot).toHaveLength(1);
    expect(mapped.wcCreatedAt.toISOString()).toBe('2026-07-23T10:00:00.000Z');
    expect(mapped.wcModifiedAt.toISOString()).toBe('2026-07-23T10:05:00.000Z');
    expect(mapped.projectionFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces the same fingerprint regardless of source object key order', () => {
    const left = mapWooCommerceOrder(orderPayload());
    const right = mapWooCommerceOrder({
      ...orderPayload(),
      billing: { first_name: 'Jane', last_name: 'Doe' },
      shipping: { city: 'Austin', country: 'US' },
      line_items: [{ total: '20.00', id: 11, name: 'Widget', quantity: 2 }],
    });

    expect(right.projectionFingerprint).toBe(left.projectionFingerprint);
    expect(canonicalSerialize({ z: 1, a: { y: 2, x: 3 } })).toBe(
      '{"a":{"x":3,"y":2},"z":1}'
    );
    expect(orderProjectionFingerprint(right)).toBe(left.projectionFingerprint);
  });
});
