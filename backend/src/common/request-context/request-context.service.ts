import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
  requestId: string;
}

@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  get requestId(): string | undefined {
    return this.storage.getStore()?.requestId;
  }

  run<T>(requestId: string, callback: () => T): T {
    return this.storage.run(Object.freeze({ requestId }), callback);
  }
}
