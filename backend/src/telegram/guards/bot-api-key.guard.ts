import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

import { ApplicationConfigService } from '../../config/application-config.service';

interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

@Injectable()
export class BotApiKeyGuard implements CanActivate {
  constructor(private readonly configuration: ApplicationConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithHeaders>();
    const header = request.headers['x-bot-api-key'];
    const presented = Array.isArray(header) ? header[0] : header;

    if (!presented || !this.matches(presented)) {
      throw new UnauthorizedException('Bot authentication is required');
    }

    return true;
  }

  private matches(presented: string): boolean {
    const expected = Buffer.from(this.configuration.telegram.internalApiKey);
    const actual = Buffer.from(presented);

    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }
}
