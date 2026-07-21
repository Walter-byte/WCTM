import { ForbiddenException, Injectable } from '@nestjs/common';

import {
  RequestContextService,
  type TenantRequestContext,
} from '../common/request-context/request-context.service';

export type TenantContext = Readonly<TenantRequestContext>;

@Injectable()
export class TenantContextService {
  constructor(private readonly requestContext: RequestContextService) {}

  get active(): TenantContext {
    const tenant = this.requestContext.tenant;

    if (!tenant) {
      throw new ForbiddenException('Tenant context is not available');
    }

    return tenant;
  }

  set(context: TenantContext): void {
    this.requestContext.setTenant(context);
  }
}
