import { describe, expect, it } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';
import type { QueueRuntimeService } from '../queue/queue-runtime.service';
import { ReadinessService } from './readiness.service';

function readiness(
  postgres: () => Promise<unknown>,
  redis: () => Promise<void>
): ReadinessService {
  const prisma = { $queryRaw: postgres } as unknown as PrismaService;
  const queueRuntime = { ping: redis } as unknown as QueueRuntimeService;

  return new ReadinessService(prisma, queueRuntime);
}

describe('ReadinessService', () => {
  it('returns ready only when PostgreSQL and Redis respond', async () => {
    const service = readiness(
      async () => [{ '?column?': 1 }],
      async () => undefined
    );

    await expect(service.check()).resolves.toEqual({
      status: 'ready',
      dependencies: { postgres: 'up', redis: 'up' },
    });
  });

  it.each(['postgres', 'redis'] as const)(
    'returns 503 when %s is unavailable',
    async (dependency) => {
      const service = readiness(
        dependency === 'postgres'
          ? async () => {
              throw new Error('database down');
            }
          : async () => [],
        dependency === 'redis'
          ? async () => {
              throw new Error('redis down');
            }
          : async () => undefined
      );

      const result = service.check();

      await expect(result).rejects.toThrow(ServiceUnavailableException);
      await expect(result).rejects.toMatchObject({ status: 503 });
    }
  );
});
