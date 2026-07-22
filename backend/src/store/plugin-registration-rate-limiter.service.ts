import {
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import { ApplicationConfigService } from '../config/application-config.service';
import { QueueRuntimeService } from '../queue/queue-runtime.service';

@Injectable()
export class PluginRegistrationRateLimiter {
  constructor(
    private readonly queueRuntime: QueueRuntimeService,
    private readonly configuration: ApplicationConfigService
  ) {}

  async assertAllowed(clientIp: string, tokenHash: string): Promise<void> {
    const ipHash = createHash('sha256').update(clientIp).digest('hex');
    const key = `plugin-registration:${ipHash}:${tokenHash.slice(0, 16)}`;
    let count: number;

    try {
      count = await this.queueRuntime.incrementFixedWindow(
        key,
        this.configuration.pluginRegistration.rateWindowSeconds
      );
    } catch {
      throw new ServiceUnavailableException(
        'Plugin registration is temporarily unavailable'
      );
    }

    if (count > this.configuration.pluginRegistration.rateLimit) {
      throw new HttpException(
        'Too many plugin registration attempts',
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
  }
}
