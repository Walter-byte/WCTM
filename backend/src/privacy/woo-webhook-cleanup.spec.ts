import { describe, expect, it, jest } from '@jest/globals';

import { removeOwnedWooWebhooks } from './woo-webhook-cleanup';

const input = {
  baseUrl: 'https://shop.example.test/',
  endpointKey: 'whk_target',
  consumerKey: 'fixture-key',
  consumerSecret: 'fixture-secret',
};

describe('WooCommerce connector webhook cleanup', () => {
  it('deletes only exact connector-owned hooks and makes no unrelated request', async () => {
    const request = jest.fn<typeof fetch>(async (_url, options) => {
      if (options?.method === 'DELETE') {
        return { ok: true } as Response;
      }
      return {
        ok: true,
        json: async () => [
          {
            id: 10,
            topic: 'order.created',
            name: 'WCTM Connector: order.created',
            delivery_url:
              'https://wctm.walterbyte.com/api/webhooks/woocommerce/whk_target',
          },
          {
            id: 11,
            topic: 'order.created',
            name: 'Accounting',
            delivery_url:
              'https://wctm.walterbyte.com/api/webhooks/woocommerce/whk_target',
          },
          {
            id: 12,
            topic: 'order.updated',
            name: 'WCTM Connector: order.updated',
            delivery_url:
              'https://wctm.walterbyte.com/api/webhooks/woocommerce/other',
          },
        ],
      } as Response;
    });

    await expect(removeOwnedWooWebhooks(input, request)).resolves.toEqual({
      complete: true,
      removed: 1,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[1]?.[0])).toContain(
      '/webhooks/10?force=true'
    );
    expect(String(request.mock.calls[1]?.[0])).not.toContain('11');
    expect(String(request.mock.calls[1]?.[0])).not.toContain('12');
  });

  it('reports manual cleanup when WooCommerce is unavailable', async () => {
    const request = jest.fn<typeof fetch>(async () => {
      throw new Error('fixture network error');
    });
    await expect(removeOwnedWooWebhooks(input, request)).resolves.toEqual({
      complete: false,
      removed: 0,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
