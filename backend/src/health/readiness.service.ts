import { Injectable, ServiceUnavailableException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { QueueRuntimeService } from '../queue/queue-runtime.service';

export interface ReadinessResult {
  status: 'ready';
  dependencies: {
    postgres: 'up';
    redis: 'up';
  };
}

@Injectable()
export class ReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueRuntime: QueueRuntimeService
  ) {}

  async check(): Promise<ReadinessResult> {
    const [postgres, redis] = await Promise.allSettled([
      this.checkPostgres(),
      this.queueRuntime.ping(),
    ]);

    if (postgres.status === 'rejected' || redis.status === 'rejected') {
      throw new ServiceUnavailableException(
        'Application dependencies are not ready'
      );
    }

    return {
      status: 'ready',
      dependencies: {
        postgres: 'up',
        redis: 'up',
      },
    };
  }

  private async checkPostgres(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}
