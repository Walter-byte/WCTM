import { describe, expect, it } from '@jest/globals';

import { minimizeWebhookPayload } from './webhook-payload-minimizer';

describe('verified webhook payload minimization', () => {
  it('keeps only fields required for order projection and delivery', () => {
    const result = minimizeWebhookPayload('order.created', {
      id: 101,
      status: 'processing',
      billing: {
        first_name: 'Jane',
        email: 'private@example.test',
        phone: 'private-phone',
      },
      shipping: {
        city: 'Austin',
        address_1: 'Main St',
        phone: 'private-phone',
      },
      line_items: [
        { name: 'Widget', quantity: 2, total: '20', metadata: 'private-note' },
      ],
      customer_note: 'private-note',
      metadata: { secret: 'private-note' },
    });

    expect(result).toMatchObject({
      id: 101,
      billing: { first_name: 'Jane' },
      shipping: { city: 'Austin', address_1: 'Main St' },
      line_items: [{ name: 'Widget', quantity: 2, total: '20' }],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private@example|private-phone|private-note/
    );
  });

  it('reduces delete and unsupported topics to identity', () => {
    expect(
      minimizeWebhookPayload('order.deleted', {
        id: 101,
        billing: { email: 'x' },
      })
    ).toEqual({ id: 101 });
    expect(
      minimizeWebhookPayload('coupon.created', { id: 44, code: 'sensitive' })
    ).toEqual({ id: 44 });
  });

  it('keeps only inventory projection and variation scan fields', () => {
    const result = minimizeWebhookPayload('product.updated', {
      id: 7,
      type: 'variable',
      variations: [11, 12],
      attributes: [{ name: 'Color', option: 'Blue', private: 'secret' }],
      description: 'secret',
      meta_data: [{ key: 'secret' }],
    });
    expect(result).toEqual({
      id: 7,
      type: 'variable',
      variations: [11, 12],
      attributes: [{ name: 'Color', option: 'Blue' }],
    });
  });
});
