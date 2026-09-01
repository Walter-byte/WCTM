import { afterEach, describe, expect, it, jest } from '@jest/globals';
import axios from 'axios';

import type { WooCommerceRestSettings } from '../../config/configuration.types';
import {
  WooCommerceClient,
  WooCommerceClientError,
} from './woocommerce.client';

const DEFAULT_RESILIENCE: WooCommerceRestSettings = {
  maxAttempts: 3,
  attemptTimeoutMs: 5000,
  totalTimeoutMs: 15000,
  backoffBaseMs: 300,
  backoffFactor: 2,
  jitterRatio: 0.2,
};

function client(
  resilience: Partial<WooCommerceRestSettings> = {}
): WooCommerceClient {
  return new WooCommerceClient({
    storeUrl: 'https://shop.example/',
    consumerKey: 'ck_sensitive_value',
    consumerSecret: 'cs_sensitive_value',
    resilience: { ...DEFAULT_RESILIENCE, ...resilience },
  });
}

function axiosFailure(options: { status?: number; code?: string }): Error {
  return Object.assign(
    new Error(
      'request failed with username=ck_sensitive_value password=cs_sensitive_value'
    ),
    {
      isAxiosError: true,
      code: options.code,
      config: {
        auth: {
          username: 'ck_sensitive_value',
          password: 'cs_sensitive_value',
        },
        headers: { Authorization: 'Basic sensitive-auth-header' },
      },
      response:
        options.status === undefined
          ? undefined
          : { status: options.status, data: { consumer_secret: 'leaked' } },
    }
  );
}

const RETRYABLE_FAILURES: [string, Error][] = [
  ['transport', axiosFailure({ code: 'ECONNRESET' })],
  ['rate-limited', axiosFailure({ status: 429 })],
  ['transport', axiosFailure({ status: 500 })],
];

const NON_RETRYABLE_STATUSES: [number, string][] = [
  [401, 'auth'],
  [403, 'auth'],
  [404, 'not-found'],
  [422, 'unexpected'],
];

const NORMALIZED_FAILURES: [Error, string][] = [
  [axiosFailure({ code: 'ECONNRESET' }), 'transport'],
  [axiosFailure({ status: 429 }), 'rate-limited'],
  [axiosFailure({ status: 401 }), 'auth'],
  [axiosFailure({ status: 404 }), 'not-found'],
  [axiosFailure({ status: 400 }), 'unexpected'],
  [axiosFailure({ code: 'ECONNABORTED' }), 'timeout'],
];

describe('WooCommerceClient', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each(RETRYABLE_FAILURES)(
    'retries %s failures up to three total attempts',
    async (_category, failure) => {
      const request = jest
        .spyOn(axios, 'get')
        .mockRejectedValueOnce(failure)
        .mockRejectedValueOnce(failure)
        .mockResolvedValue({ data: { store_name: 'Verified Shop' } });

      await expect(
        client({ backoffBaseMs: 0, jitterRatio: 0 }).validateCredentials()
      ).resolves.toEqual({ storeName: 'Verified Shop' });
      expect(request).toHaveBeenCalledTimes(3);
    }
  );

  it.each(NON_RETRYABLE_STATUSES)(
    'does not retry HTTP %i and normalizes it as %s',
    async (status, category) => {
      const request = jest
        .spyOn(axios, 'get')
        .mockRejectedValue(axiosFailure({ status }));

      await expect(client().validateCredentials()).rejects.toMatchObject({
        category,
      });
      expect(request).toHaveBeenCalledTimes(1);
    }
  );

  it.each(NORMALIZED_FAILURES)(
    'normalizes failures without leaking request secrets',
    async (failure, category) => {
      jest.spyOn(axios, 'get').mockRejectedValue(failure);

      let captured: unknown;
      try {
        await client({ maxAttempts: 1 }).validateCredentials();
      } catch (error: unknown) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(WooCommerceClientError);
      expect(captured).toMatchObject({
        category,
      });
      expect(String(captured)).not.toMatch(
        /ck_sensitive_value|cs_sensitive_value|sensitive-auth-header|leaked/
      );
      expect(JSON.stringify(captured)).not.toMatch(
        /ck_sensitive_value|cs_sensitive_value|sensitive-auth-header|leaked/
      );
    }
  );

  it('uses the configured per-attempt timeout and the normalized probe URL', async () => {
    const request = jest
      .spyOn(axios, 'get')
      .mockResolvedValue({ data: { name: 'Verified Shop' } });

    await expect(client().validateCredentials()).resolves.toEqual({
      storeName: 'Verified Shop',
    });
    expect(request).toHaveBeenCalledWith(
      'https://shop.example/wp-json/wc/v3/system_status',
      expect.objectContaining({ timeout: 5000 })
    );
  });

  it('fetches exactly one order through the same bounded M6 client', async () => {
    const payload = { id: 101, status: 'processing' };
    const request = jest
      .spyOn(axios, 'get')
      .mockResolvedValue({ data: payload });

    await expect(client().fetchOrder('101')).resolves.toEqual(payload);
    expect(request).toHaveBeenCalledWith(
      'https://shop.example/wp-json/wc/v3/orders/101',
      expect.objectContaining({
        timeout: 5000,
        auth: {
          username: 'ck_sensitive_value',
          password: 'cs_sensitive_value',
        },
      })
    );
  });

  it('uses bounded current-state product and variation reads with narrow fields', async () => {
    const request = jest
      .spyOn(axios, 'get')
      .mockResolvedValue({ data: [{ id: 101 }] });
    const inventoryClient = client();

    await inventoryClient.fetchProduct('101');
    await inventoryClient.fetchProductVariation('101', '202');
    await inventoryClient.fetchProductsPage(2, 25);
    await inventoryClient.fetchProductVariationsPage('101', 3, 25);

    expect(request).toHaveBeenCalledTimes(4);
    const urls = request.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toMatch(/\/products\/101\?_fields=/);
    expect(urls[1]).toMatch(/\/products\/101\/variations\/202\?_fields=/);
    expect(urls[2]).toMatch(
      /\/products\?page=2&per_page=25&orderby=id&order=asc&status=any&_fields=/
    );
    expect(urls[3]).toMatch(
      /\/products\/101\/variations\?page=3&per_page=25&orderby=id&order=asc&_fields=/
    );
    for (const url of urls) {
      const fields = decodeURIComponent(url.split('_fields=')[1] ?? '');
      expect(fields).toContain('stock_quantity');
      expect(fields).toContain('date_modified_gmt');
      expect(fields).not.toMatch(/description|price|images|categories|tags/);
    }
    for (const call of request.mock.calls) {
      expect(call[1]).toMatchObject({ timeout: 5000 });
    }
  });

  it('dispatches one status write without automatically retrying it', async () => {
    const payload = { id: 101, status: 'completed' };
    const request = jest
      .spyOn(axios, 'put')
      .mockResolvedValue({ data: payload });

    await expect(
      client().updateOrderStatus('101', 'completed')
    ).resolves.toEqual(payload);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      'https://shop.example/wp-json/wc/v3/orders/101',
      { status: 'completed' },
      expect.objectContaining({
        timeout: 5000,
        auth: {
          username: 'ck_sensitive_value',
          password: 'cs_sensitive_value',
        },
      })
    );
  });

  it.each<[string, boolean]>([
    ['internal', false],
    ['customer-visible', true],
  ])(
    'dispatches one %s note write without automatic retry',
    async (_label, customerNote) => {
      const payload = { id: 501, customer_note: customerNote };
      const request = jest
        .spyOn(axios, 'post')
        .mockResolvedValue({ data: payload });

      await expect(
        client().createOrderNote('101', 'Plain note text', customerNote)
      ).resolves.toEqual(payload);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        'https://shop.example/wp-json/wc/v3/orders/101/notes',
        { note: 'Plain note text', customer_note: customerNote },
        expect.objectContaining({
          timeout: 5000,
          auth: {
            username: 'ck_sensitive_value',
            password: 'cs_sensitive_value',
          },
        })
      );
    }
  );

  it('does not retry an ambiguous note POST failure', async () => {
    const request = jest
      .spyOn(axios, 'post')
      .mockRejectedValue(axiosFailure({ status: 500 }));

    await expect(
      client().createOrderNote('101', 'Plain note text', false)
    ).rejects.toMatchObject({ category: 'transport' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('creates the four required order webhooks and verifies their public destination', async () => {
    const deliveryUrl =
      'https://pilot.example/api/webhooks/woocommerce/whk_endpoint';
    const topics = [
      'order.created',
      'order.updated',
      'order.deleted',
      'order.restored',
    ];
    const get = jest
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: topics.map((topic, index) => ({
          id: index + 1,
          name: `WC Telegram private pilot: ${topic}`,
          status: 'active',
          topic,
          delivery_url: deliveryUrl,
        })),
      });
    const post = jest
      .spyOn(axios, 'post')
      .mockResolvedValue({ data: { id: 1 } });

    await expect(
      client().ensureRequiredOrderWebhooks(deliveryUrl, 'webhook-secret-value')
    ).resolves.toBeUndefined();

    expect(get).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(4);
    expect(post.mock.calls.map((call) => call[1])).toEqual(
      topics.map((topic) =>
        expect.objectContaining({
          topic,
          delivery_url: deliveryUrl,
          secret: 'webhook-secret-value',
        })
      )
    );
  });

  it('leaves already-correct managed webhooks unchanged on an idempotent rerun', async () => {
    const deliveryUrl =
      'https://pilot.example/api/webhooks/woocommerce/whk_endpoint';
    const data = [
      'order.created',
      'order.updated',
      'order.deleted',
      'order.restored',
    ].map((topic, index) => ({
      id: index + 1,
      name: `WC Telegram private pilot: ${topic}`,
      status: 'active',
      topic,
      delivery_url: deliveryUrl,
    }));
    jest.spyOn(axios, 'get').mockResolvedValue({ data });
    const post = jest.spyOn(axios, 'post');
    const put = jest.spyOn(axios, 'put');

    await client().ensureRequiredOrderWebhooks(
      deliveryUrl,
      'webhook-secret-value'
    );

    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('creates and verifies the four inventory webhooks with the shared endpoint and secret', async () => {
    const deliveryUrl =
      'https://pilot.example/api/webhooks/woocommerce/whk_endpoint';
    const topics = [
      'product.created',
      'product.updated',
      'product.deleted',
      'product.restored',
    ];
    const get = jest
      .spyOn(axios, 'get')
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: topics.map((topic, index) => ({
          id: index + 1,
          name: `WC Telegram private pilot: ${topic}`,
          status: 'active',
          topic,
          delivery_url: deliveryUrl,
        })),
      });
    const post = jest
      .spyOn(axios, 'post')
      .mockResolvedValue({ data: { id: 1 } });

    await expect(
      client().ensureRequiredInventoryWebhooks(
        deliveryUrl,
        'webhook-secret-value'
      )
    ).resolves.toBeUndefined();

    expect(get).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledTimes(4);
    expect(post.mock.calls.map((call) => call[1])).toEqual(
      topics.map((topic) =>
        expect.objectContaining({
          topic,
          delivery_url: deliveryUrl,
          secret: 'webhook-secret-value',
        })
      )
    );
  });

  it('verifies one shared HTTPS delivery URL for the exact server endpoint key', async () => {
    const deliveryUrl =
      'https://app.example/api/webhooks/woocommerce/whk_endpoint';
    const data = [
      'order.created',
      'order.updated',
      'order.deleted',
      'order.restored',
    ].map((topic, index) => ({
      id: index + 1,
      name: `WCTM Connector: ${topic}`,
      status: 'active',
      topic,
      delivery_url: deliveryUrl,
    }));
    jest.spyOn(axios, 'get').mockResolvedValue({ data });

    await expect(
      client().hasRequiredOrderWebhooksForEndpointKey('whk_endpoint')
    ).resolves.toBe(true);
  });

  it('rejects incomplete, non-HTTPS, or mismatched webhook destinations', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({
      data: ['order.created', 'order.updated', 'order.deleted'].map(
        (topic, index) => ({
          id: index + 1,
          name: `WCTM Connector: ${topic}`,
          status: 'active',
          topic,
          delivery_url: 'http://app.example/api/webhooks/woocommerce/whk_other',
        })
      ),
    });

    await expect(
      client().hasRequiredOrderWebhooksForEndpointKey('whk_endpoint')
    ).resolves.toBe(false);
  });

  it('enforces the total operation hard cap and aborts the active request', async () => {
    jest.useFakeTimers();
    const request = jest
      .spyOn(axios, 'get')
      .mockImplementation(() => new Promise(() => undefined));
    const validation = client().validateCredentials();
    const expectedFailure = expect(validation).rejects.toMatchObject({
      category: 'timeout',
    });

    await jest.advanceTimersByTimeAsync(15000);

    await expectedFailure;
    const requestOptions = request.mock.calls[0]?.[1];
    expect(requestOptions?.signal?.aborted).toBe(true);
  });

  it('uses 300ms and 600ms exponential retry delays at zero jitter', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const request = jest
      .spyOn(axios, 'get')
      .mockRejectedValue(axiosFailure({ status: 500 }));
    const validation = client().validateCredentials();
    const expectedFailure = expect(validation).rejects.toMatchObject({
      category: 'transport',
    });

    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(299);
    expect(request).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(599);
    expect(request).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(3);
    await expectedFailure;
  });

  it('preserves the connection-test response shape for success and failure', async () => {
    const request = jest.spyOn(axios, 'get');
    request.mockResolvedValueOnce({ data: { store_name: 'Verified Shop' } });

    await expect(client().testConnection()).resolves.toEqual({
      success: true,
      storeName: 'Verified Shop',
    });

    request.mockRejectedValueOnce(axiosFailure({ status: 401 }));
    await expect(client().testConnection()).resolves.toEqual({
      success: false,
      error: 'WooCommerce authentication failed',
      category: 'auth',
    });
  });
});
