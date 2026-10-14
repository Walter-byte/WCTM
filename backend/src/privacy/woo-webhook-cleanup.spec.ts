import { describe, expect, it, jest } from '@jest/globals';

import { removeOwnedWooWebhooks } from './woo-webhook-cleanup';

const input = {
  baseUrl: 'https://shop.example.test/',
  connectorOrigin: 'https://wctm.walterbyte.com',
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

  it('enumerates both pages before deleting from a mutable 101-hook list', async () => {
    const hooks = Array.from({ length: 101 }, (_, i) => ({
      id: i + 1,
      topic: 'order.created',
      name:
        i === 0 || i === 100 ? 'WCTM Connector: order.created' : 'Accounting',
      delivery_url:
        'https://wctm.walterbyte.com/api/webhooks/woocommerce/whk_target',
    }));
    const request = jest.fn<typeof fetch>(async (url, options) => {
      const parsed = new URL(String(url));
      if (options?.method === 'DELETE') {
        const id = Number(parsed.pathname.split('/').pop());
        const index = hooks.findIndex((hook) => hook.id === id);
        expect(index).toBeGreaterThanOrEqual(0);
        hooks.splice(index, 1);
        return { ok: true } as Response;
      }
      const page = Number(parsed.searchParams.get('page'));
      return {
        ok: true,
        json: async () => hooks.slice((page - 1) * 100, page * 100),
      } as Response;
    });
    await expect(removeOwnedWooWebhooks(input, request)).resolves.toEqual({
      complete: true,
      removed: 2,
    });
    expect(hooks).toHaveLength(99);
    expect(hooks.every((hook) => hook.name === 'Accounting')).toBe(true);
    expect(
      request.mock.calls
        .slice(0, 2)
        .every((call) => call[1]?.method !== 'DELETE')
    ).toBe(true);
  });

  it('requires manual reconciliation when the page cap prevents complete enumeration', async () => {
    const request = jest.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          json: async () =>
            Array.from({ length: 100 }, (_, i) => ({
              id: i + 1,
              topic: 'order.created',
              name: 'WCTM Connector: order.created',
              delivery_url:
                'https://wctm.walterbyte.com/api/webhooks/woocommerce/whk_target',
            })),
        }) as Response
    );
    await expect(removeOwnedWooWebhooks(input, request)).resolves.toEqual({
      complete: false,
      removed: 0,
    });
    expect(request).toHaveBeenCalledTimes(10);
    expect(
      request.mock.calls.every((call) => call[1]?.method !== 'DELETE')
    ).toBe(true);
  });

  it('reports partial removal on deletion failure', async () => {
    const request = jest.fn<typeof fetch>(async (url, options) =>
      options?.method === 'DELETE'
        ? ({ ok: String(url).includes('/10?') } as Response)
        : ({
            ok: true,
            json: async () =>
              [10, 11].map((id) => ({
                id,
                topic: 'order.created',
                name: 'WCTM Connector: order.created',
                delivery_url:
                  'https://wctm.walterbyte.com/api/webhooks/woocommerce/whk_target',
              })),
          } as Response)
    );
    await expect(removeOwnedWooWebhooks(input, request)).resolves.toEqual({
      complete: false,
      removed: 1,
    });
  });

  it('requires manual reconciliation for a matching route at another origin', async () => {
    const request = jest.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          json: async () => [
            {
              id: 13,
              topic: 'order.created',
              name: 'WCTM Connector: order.created',
              delivery_url:
                'https://unrelated.example.test/api/webhooks/woocommerce/whk_target',
            },
          ],
        }) as Response
    );
    await expect(removeOwnedWooWebhooks(input, request)).resolves.toEqual({
      complete: false,
      removed: 0,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('fails closed without an exact HTTPS connector origin', async () => {
    const request = jest.fn<typeof fetch>();
    await expect(
      removeOwnedWooWebhooks(
        {
          ...input,
          connectorOrigin: 'https://wctm.walterbyte.com/other',
        },
        request
      )
    ).resolves.toEqual({ complete: false, removed: 0 });
    expect(request).not.toHaveBeenCalled();
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
