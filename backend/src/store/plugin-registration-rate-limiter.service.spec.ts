import { describe, expect, it, jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';

import type { ApplicationConfigService } from '../config/application-config.service';
import type { QueueRuntimeService } from '../queue/queue-runtime.service';
import { PluginRegistrationRateLimiter } from './plugin-registration-rate-limiter.service';

function setup(count: number | Error): {
  incrementFixedWindow: ReturnType<typeof jest.fn>;
  limiter: PluginRegistrationRateLimiter;
} {
  const incrementFixedWindow =
    count instanceof Error
      ? jest.fn().mockRejectedValue(count as never)
      : jest.fn().mockResolvedValue(count as never);
  const limiter = new PluginRegistrationRateLimiter(
    { incrementFixedWindow } as unknown as QueueRuntimeService,
    {
      pluginRegistration: {
        tokenTtlSeconds: 900,
        rateLimit: 10,
        rateWindowSeconds: 60,
      },
    } as ApplicationConfigService
  );

  return { incrementFixedWindow, limiter };
}

describe('PluginRegistrationRateLimiter', () => {
  it('allows requests within the fixed window using an IP hash and token-hash prefix', async () => {
    const fixture = setup(10);
    const tokenHash = 'a'.repeat(64);

    await expect(
      fixture.limiter.assertAllowed('203.0.113.5', tokenHash)
    ).resolves.toBeUndefined();
    expect(fixture.incrementFixedWindow).toHaveBeenCalledWith(
      `plugin-registration:${createHash('sha256').update('203.0.113.5').digest('hex')}:${'a'.repeat(16)}`,
      60
    );
    expect(
      JSON.stringify(fixture.incrementFixedWindow.mock.calls)
    ).not.toContain('203.0.113.5');
  });

  it('returns a generic 429 after the configured limit', async () => {
    const fixture = setup(11);

    await expect(
      fixture.limiter.assertAllowed('203.0.113.5', 'b'.repeat(64))
    ).rejects.toMatchObject({ status: 429 });
  });

  it('fails closed with a generic 503 when Redis is unavailable', async () => {
    const fixture = setup(new Error('redis password=secret unavailable'));

    await expect(
      fixture.limiter.assertAllowed('203.0.113.5', 'c'.repeat(64))
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
