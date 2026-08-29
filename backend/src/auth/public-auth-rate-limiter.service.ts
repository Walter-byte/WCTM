import {
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

import { ApplicationConfigService } from '../config/application-config.service';
import { QueueRuntimeService } from '../queue/queue-runtime.service';
import { authIdentifierFingerprint } from './public-auth-identifiers';

type PublicAuthOperation = 'register' | 'login';

@Injectable()
export class PublicAuthRateLimiter {
  constructor(
    private readonly queueRuntime: QueueRuntimeService,
    private readonly configuration: ApplicationConfigService
  ) {}

  async assertRegistrationAllowed(
    clientIp: string,
    normalizedEmail: string
  ): Promise<void> {
    await this.assertAllowed('register', clientIp, normalizedEmail);
  }

  async assertLoginAllowed(
    clientIp: string,
    normalizedEmail: string
  ): Promise<void> {
    await this.assertAllowed('login', clientIp, normalizedEmail);
  }

  private async assertAllowed(
    operation: PublicAuthOperation,
    clientIp: string,
    normalizedEmail: string
  ): Promise<void> {
    const ipHash = authIdentifierFingerprint(clientIp);
    const emailHash = authIdentifierFingerprint(normalizedEmail);
    const key = `public-auth:${operation}:${ipHash}:${emailHash}`;
    const limit =
      operation === 'register'
        ? this.configuration.publicAuth.registerRateLimit
        : this.configuration.publicAuth.loginRateLimit;
    const windowSeconds =
      operation === 'register'
        ? this.configuration.publicAuth.registerRateWindowSeconds
        : this.configuration.publicAuth.loginRateWindowSeconds;
    let count: number;

    try {
      count = await this.queueRuntime.incrementFixedWindow(key, windowSeconds);
    } catch {
      throw new ServiceUnavailableException(
        'Account authentication is temporarily unavailable'
      );
    }

    if (count > limit) {
      throw new HttpException(
        'Too many account authentication attempts',
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
  }
}
