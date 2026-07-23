import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantRequestContext {
  tenantId: string;
  userId: string;
  membershipRole: string;
}

interface RequestContext {
  requestId: string;
  telegramUpdateId?: string;
  tenant?: Readonly<TenantRequestContext>;
}

@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  get requestId(): string | undefined {
    return this.storage.getStore()?.requestId;
  }

  get tenant(): Readonly<TenantRequestContext> | undefined {
    return this.storage.getStore()?.tenant;
  }

  get telegramUpdateId(): string | undefined {
    return this.storage.getStore()?.telegramUpdateId;
  }

  setTenant(tenant: TenantRequestContext): void {
    const context = this.storage.getStore();

    if (!context) {
      throw new Error('Request context is not available');
    }

    context.tenant = Object.freeze({ ...tenant });
  }

  run<T>(requestId: string, callback: () => T, telegramUpdateId?: string): T {
    return this.storage.run({ requestId, telegramUpdateId }, callback);
  }
}
