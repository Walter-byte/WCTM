import type { BotConfiguration } from './config';

const INTERNAL_REQUEST_TIMEOUT_MS = 5_000;

export interface TelegramIdentity {
  telegramUserId: string;
  telegramChatId: string;
  updateId: string;
}

export interface TelegramAuthorizationStatus {
  linked: boolean;
  authorized: boolean;
  membershipState: 'active' | 'none';
  activeTenantId: string | null;
  activeStoreId: string | null;
  tenantSelectionRequired: boolean;
  storeSelectionRequired: boolean;
  selectionRequired: boolean;
}

export type TelegramRedeemResult =
  | { status: 'invalid_or_expired' }
  | ({ status: 'linked' } & TelegramAuthorizationStatus);

export type TelegramUnlinkResult =
  | { status: 'confirmation_required' }
  | { status: 'unauthorized' }
  | { status: 'unlinked' };

export class BackendUnavailableError extends Error {
  constructor() {
    super('Backend is unavailable');
    this.name = 'BackendUnavailableError';
  }
}

export class InternalBackendClient {
  constructor(
    private readonly configuration: Pick<
      BotConfiguration,
      'internalApiKey' | 'backendInternalUrl'
    >,
    private readonly request: typeof fetch = fetch
  ) {}

  redeem(
    identity: TelegramIdentity,
    token: string
  ): Promise<TelegramRedeemResult> {
    return this.post<TelegramRedeemResult>('redeem', identity, {
      ...identity,
      chatType: 'private',
      token,
    });
  }

  status(identity: TelegramIdentity): Promise<TelegramAuthorizationStatus> {
    return this.post<TelegramAuthorizationStatus>('status', identity, identity);
  }

  unlink(
    identity: TelegramIdentity,
    confirmed: boolean
  ): Promise<TelegramUnlinkResult> {
    return this.post<TelegramUnlinkResult>('unlink', identity, {
      ...identity,
      confirmed,
    });
  }

  private async post<T>(
    path: string,
    identity: TelegramIdentity,
    body: object
  ): Promise<T> {
    const correlationId = `telegram-update-${identity.updateId}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      INTERNAL_REQUEST_TIMEOUT_MS
    );

    try {
      const response = await this.request(
        `${this.configuration.backendInternalUrl}/internal/telegram/${path}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-bot-api-key': this.configuration.internalApiKey,
            'x-correlation-id': correlationId,
            'x-telegram-update-id': identity.updateId,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        throw new BackendUnavailableError();
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof BackendUnavailableError) {
        throw error;
      }

      throw new BackendUnavailableError();
    } finally {
      clearTimeout(timeout);
    }
  }
}
