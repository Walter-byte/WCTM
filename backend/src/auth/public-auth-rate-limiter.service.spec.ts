import { describe, expect, it, jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';

import type { ApplicationConfigService } from '../config/application-config.service';
import type { QueueRuntimeService } from '../queue/queue-runtime.service';
import {
  authIdentifierFingerprint,
  normalizeEmail,
} from './public-auth-identifiers';
import { PublicAuthRateLimiter } from './public-auth-rate-limiter.service';

function setup(count: number | Error): {
  incrementFixedWindow: ReturnType<typeof jest.fn>;
  limiter: PublicAuthRateLimiter;
} {
  const incrementFixedWindow =
    count instanceof Error
      ? jest.fn().mockRejectedValue(count as never)
      : jest.fn().mockResolvedValue(count as never);
  const limiter = new PublicAuthRateLimiter(
    { incrementFixedWindow } as unknown as QueueRuntimeService,
    {
      publicAuth: {
        registerRateLimit: 5,
        registerRateWindowSeconds: 60,
        loginRateLimit: 10,
        loginRateWindowSeconds: 120,
      },
    } as ApplicationConfigService
  );

  return { incrementFixedWindow, limiter };
}

describe('PublicAuthRateLimiter', () => {
  it('uses independent hashed register and login fixed-window keys', async () => {
    const fixture = setup(1);
    const clientIp = '203.0.113.10';
    const email = normalizeEmail(' User@Example.COM ');
    const suffix = `${authIdentifierFingerprint(clientIp)}:${authIdentifierFingerprint(email)}`;

    await fixture.limiter.assertRegistrationAllowed(clientIp, email);
    await fixture.limiter.assertLoginAllowed(clientIp, email);

    expect(fixture.incrementFixedWindow).toHaveBeenNthCalledWith(
      1,
      `public-auth:register:${suffix}`,
      60
    );
    expect(fixture.incrementFixedWindow).toHaveBeenNthCalledWith(
      2,
      `public-auth:login:${suffix}`,
      120
    );
    const calls = JSON.stringify(fixture.incrementFixedWindow.mock.calls);
    expect(calls).not.toContain(clientIp);
    expect(calls).not.toContain(email);
  });

  it('enforces register and login limits independently', async () => {
    const registration = setup(6);
    const login = setup(11);

    await expect(
      registration.limiter.assertRegistrationAllowed('ip', 'a@example.com')
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      login.limiter.assertLoginAllowed('ip', 'a@example.com')
    ).rejects.toMatchObject({ status: 429 });
  });

  it('fails closed with a generic 503 when Redis is unavailable', async () => {
    const fixture = setup(new Error('redis password=secret unavailable'));

    await expect(
      fixture.limiter.assertLoginAllowed('ip', 'a@example.com')
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
