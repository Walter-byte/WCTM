import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { JwtPayload } from '../auth.service';

interface AuthenticatedRequest {
  user?: JwtPayload;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): JwtPayload | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().user
);
