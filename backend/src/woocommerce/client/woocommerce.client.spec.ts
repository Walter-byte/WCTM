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
