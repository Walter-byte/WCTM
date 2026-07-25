import { Injectable } from '@nestjs/common';
import { MembershipRole, Prisma, StoreStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { AuthService, type JwtPayload } from '../auth/auth.service';
import { EncryptionService } from '../common/encryption/encryption.service';
import { RequestContextService } from '../common/request-context/request-context.service';
import { ApplicationConfigService } from '../config/application-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoreRegistrationService } from '../store/store-registration.service';
import { StoreService } from '../store/store.service';
import { TenantContextService } from '../tenant/tenant-context.service';
import { TelegramLinkingService } from '../telegram/telegram-linking.service';
import { TelegramOrderService } from '../telegram/telegram-order.service';
import { WooCommerceClient } from '../woocommerce/client/woocommerce.client';
import { approvedPublicHttpsOrigin } from './pilot-url';

const PILOT_CONTEXT_REQUEST_ID = 'pilot-operator-tool';

export interface PilotIdentityInput {
  email: string;
  displayName: string;
  tenantName: string;
}

export interface PilotStoreInput {
  name: string;
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

export interface PilotIdentity {
  userId: string;
  tenantId: string;
}

export interface PilotSetupResult {
  identityCreated: boolean;
  storeCredentialsRequired: boolean;
  alreadyLinked: boolean;
  startCommand?: string;
}

export type PilotReadinessCheckKey =
  | 'user'
  | 'tenant'
  | 'ownerMembership'
  | 'activeStore'
  | 'restConnection'
  | 'webhooks'
  | 'telegram'
  | 'projectedOrder'
  | 'telegramOrderFlow';

export interface PilotReadinessCheck {
  key: PilotReadinessCheckKey;
  label: string;
  pass: boolean;
  action: string;
}

interface PilotStoreRecord {
  id: string;
  tenantId: string;
  baseUrl: string;
  status: StoreStatus;
  consumerKeyEncrypted: string;
  consumerSecretEncrypted: string;
  webhookSecretEncrypted: string | null;
  webhookEndpointKey: string | null;
  deletedAt: Date | null;
}

interface LinkedTelegramContext {
  telegramUserId: bigint;
  telegramChatId: bigint;
}

@Injectable()
export class PilotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configuration: ApplicationConfigService,
    private readonly auth: AuthService,
    private readonly requestContext: RequestContextService,
    private readonly tenantContext: TenantContextService,
    private readonly stores: StoreService,
    private readonly storeRegistration: StoreRegistrationService,
    private readonly encryption: EncryptionService,
    private readonly telegramLinking: TelegramLinkingService,
    private readonly telegramOrders: TelegramOrderService
  ) {}

  assertPilotEnvironment(): string {
    if (!this.configuration.pilot.enabled) {
      throw new Error(
        'Private-pilot tooling is disabled; set PILOT_MODE=true explicitly'
      );
    }

    return approvedPublicHttpsOrigin(this.configuration.pilot.webhookBaseUrl);
  }

  async bootstrapIdentity(input: PilotIdentityInput): Promise<{
    identity: PilotIdentity;
    created: boolean;
  }> {
    this.assertPilotEnvironment();
    const normalized = this.normalizeIdentity(input);

    return this.prisma.$transaction(
      async (transaction) => {
        const [users, tenants, memberships] = await Promise.all([
          transaction.user.findMany({
            select: { id: true, email: true, displayName: true },
          }),
          transaction.tenant.findMany({
            select: { id: true, name: true, deletedAt: true },
          }),
          transaction.membership.findMany({
            select: {
              tenantId: true,
              userId: true,
              role: true,
              deletedAt: true,
            },
          }),
        ]);

        if (
          users.length === 0 &&
          tenants.length === 0 &&
          memberships.length === 0
        ) {
          const userId = `usr_${randomUUID()}`;
          const tenantId = `ten_${randomUUID()}`;

          await transaction.user.create({
            data: {
              id: userId,
              email: normalized.email,
              displayName: normalized.displayName,
            },
            select: { id: true },
          });
          await transaction.tenant.create({
            data: { id: tenantId, name: normalized.tenantName },
            select: { id: true },
          });
          await transaction.membership.create({
            data: {
              id: `mem_${randomUUID()}`,
              tenantId,
              userId,
              role: MembershipRole.OWNER,
            },
            select: { id: true },
          });
          await transaction.auditLog.create({
            data: {
              id: `aud_${randomUUID()}`,
              tenantId,
              userId,
              action: 'pilot.bootstrap_created',
              entityType: 'Tenant',
              entityId: tenantId,
              metadata: { role: MembershipRole.OWNER },
            },
            select: { id: true },
          });

          return { identity: { userId, tenantId }, created: true };
        }

        const user = users[0];
        const tenant = tenants[0];
        const membership = memberships[0];
        const samePilotIdentity =
          users.length === 1 &&
          tenants.length === 1 &&
          memberships.length === 1 &&
          user?.email.toLowerCase() === normalized.email &&
          user.displayName === normalized.displayName &&
          tenant?.name === normalized.tenantName &&
          tenant.deletedAt === null &&
          membership?.userId === user.id &&
          membership.tenantId === tenant.id &&
          membership.role === MembershipRole.OWNER &&
          membership.deletedAt === null;

        if (!samePilotIdentity || !user || !tenant) {
          throw new Error(
            'Pilot setup refused: the database contains an unrelated User/Tenant bootstrap'
          );
        }

        return {
          identity: { userId: user.id, tenantId: tenant.id },
          created: false,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  async storeCredentialsRequired(identity: PilotIdentity): Promise<boolean> {
    const stores = await this.pilotStores(identity.tenantId);

    if (stores.length > 1) {
      throw new Error(
        'Pilot setup refused: exactly one pilot Store is supported'
      );
    }

    return stores.length === 0;
  }

  async setup(
    identityResult: { identity: PilotIdentity; created: boolean },
    storeInput?: PilotStoreInput
  ): Promise<PilotSetupResult> {
    const webhookOrigin = this.assertPilotEnvironment();
    const { identity } = identityResult;
    const accessToken = await this.auth.signAccessToken({
      sub: identity.userId,
      tenantId: identity.tenantId,
    });
    const accessPayload = await this.auth.verifyAccessToken(accessToken);

    return this.runAsPilot(identity, async () => {
      let store = await this.requireOrCreateStore(identity, storeInput);

      await this.validateStoredConnection(store);
      const credentials =
        await this.storeRegistration.provisionWebhookCredentials(
          store.id,
          false
        );
      store = await this.requirePilotStore(identity.tenantId, store.id);
      const webhookSecret =
        credentials.webhookSecret ??
        (store.webhookSecretEncrypted
          ? this.encryption.decrypt(store.webhookSecretEncrypted)
          : undefined);

      if (!webhookSecret || !store.webhookEndpointKey) {
        throw new Error('Pilot webhook credentials could not be provisioned');
      }

      const deliveryUrl = this.webhookDeliveryUrl(
        webhookOrigin,
        store.webhookEndpointKey
      );
      await this.woocommerceClient(store).ensureRequiredOrderWebhooks(
        deliveryUrl,
        webhookSecret
      );
      await this.activatePilotStore(identity, store.id);

      const linked = await this.linkedTelegramContext(identity, store.id);

      if (linked) {
        return {
          identityCreated: identityResult.created,
          storeCredentialsRequired: storeInput !== undefined,
          alreadyLinked: true,
        };
      }

      const linkToken = await this.telegramLinking.issueToken(
        accessPayload as JwtPayload
      );

      return {
        identityCreated: identityResult.created,
        storeCredentialsRequired: storeInput !== undefined,
        alreadyLinked: false,
        startCommand: `/start ${linkToken.token}`,
      };
    });
  }

  async readiness(): Promise<PilotReadinessCheck[]> {
    const webhookOrigin = this.assertPilotEnvironment();
    const [users, tenantRecords, membershipRecords] = await Promise.all([
      this.prisma.user.findMany({ select: { id: true } }),
      this.prisma.tenant.findMany({
        select: { id: true, deletedAt: true },
      }),
      this.prisma.membership.findMany({
        select: {
          tenantId: true,
          userId: true,
          role: true,
          deletedAt: true,
        },
      }),
    ]);
    const tenants = tenantRecords.filter((tenant) => tenant.deletedAt === null);
    const memberships = membershipRecords.filter(
      (membership) => membership.deletedAt === null
    );
    const user = users.length === 1 ? users[0] : undefined;
    const tenant = tenants.length === 1 ? tenants[0] : undefined;
    const owner =
      user && tenant
        ? memberships.filter(
            (membership) =>
              membership.userId === user.id &&
              membership.tenantId === tenant.id &&
              membership.role === MembershipRole.OWNER
          )
        : [];
    const stores = tenant ? await this.pilotStores(tenant.id) : [];
    const activeStores = stores.filter(
      (store) => store.status === StoreStatus.ACTIVE && store.deletedAt === null
    );
    const store =
      stores.length === 1 && activeStores.length === 1
        ? activeStores[0]
        : undefined;
    let restConnected = false;
    let webhooksConfigured = false;
    let telegram: LinkedTelegramContext | undefined;
    let projectedOrder = false;
    let telegramOrderFlow = false;

    if (store && user && tenant && owner.length === 1) {
      const identity = { userId: user.id, tenantId: tenant.id };

      await this.runAsPilot(identity, async () => {
        try {
          restConnected = (await this.stores.testConnection(store.id)).success;
        } catch {
          restConnected = false;
        }

        if (
          restConnected &&
          store.webhookEndpointKey &&
          store.webhookSecretEncrypted
        ) {
          try {
            webhooksConfigured = await this.woocommerceClient(
              store
            ).hasRequiredOrderWebhooks(
              this.webhookDeliveryUrl(webhookOrigin, store.webhookEndpointKey)
            );
          } catch {
            webhooksConfigured = false;
          }
        }
      });

      telegram = await this.linkedTelegramContext(identity, store.id);

      if (restConnected && webhooksConfigured) {
        projectedOrder = await this.pollForProjectedOrder(tenant.id, store.id);

        if (projectedOrder && telegram) {
          try {
            const result = await this.telegramOrders.list({
              telegram: {
                userId: telegram.telegramUserId.toString(),
                chatId: telegram.telegramChatId.toString(),
              },
            });
            telegramOrderFlow =
              result.state === 'OK' && result.orders.length > 0;
          } catch {
            telegramOrderFlow = false;
          }
        }
      }
    }

    return [
      this.check(
        'user',
        'pilot User exists',
        users.length === 1,
        'Run pilot:setup against an empty private-pilot database'
      ),
      this.check(
        'tenant',
        'Tenant exists',
        tenantRecords.length === 1 && tenants.length === 1,
        'Run pilot:setup to create the single pilot Tenant'
      ),
      this.check(
        'ownerMembership',
        'OWNER Membership exists',
        owner.length === 1 &&
          membershipRecords.length === 1 &&
          memberships.length === 1,
        'Run pilot:setup to provision the pilot OWNER Membership'
      ),
      this.check(
        'activeStore',
        'exactly one eligible ACTIVE Store',
        store !== undefined,
        'Run pilot:setup and resolve the Store validation failure'
      ),
      this.check(
        'restConnection',
        'Store REST connection succeeds',
        restConnected,
        'Restore access for the originally configured WooCommerce REST key, then rerun pilot:readiness'
      ),
      this.check(
        'webhooks',
        'required order webhooks are configured',
        webhooksConfigured,
        'Verify the public Caddy HTTPS route and rerun pilot:setup'
      ),
      this.check(
        'telegram',
        'Telegram account is linked and authorized',
        telegram !== undefined,
        'Paste the one-time /start command from pilot:setup into the private bot chat'
      ),
      this.check(
        'projectedOrder',
        'synthetic order is projected locally',
        projectedOrder,
        'Create one clearly marked non-terminal synthetic order in WooCommerce admin, then rerun pilot:readiness'
      ),
      this.check(
        'telegramOrderFlow',
        'synthetic order is visible to the Telegram order flow',
        telegramOrderFlow,
        'After projection succeeds, open /orders in the linked private bot chat and rerun pilot:readiness'
      ),
    ];
  }

  private async requireOrCreateStore(
    identity: PilotIdentity,
    input: PilotStoreInput | undefined
  ): Promise<PilotStoreRecord> {
    const existing = await this.pilotStores(identity.tenantId);

    if (existing.length > 1) {
      throw new Error(
        'Pilot setup refused: exactly one pilot Store is supported'
      );
    }

    if (existing[0]) {
      if (existing[0].deletedAt !== null) {
        throw new Error(
          'Pilot setup refused: the existing Store has been deleted'
        );
      }

      if (
        existing[0].status !== StoreStatus.PENDING &&
        existing[0].status !== StoreStatus.ACTIVE
      ) {
        throw new Error(
          'Pilot setup refused: the existing Store is not PENDING or ACTIVE'
        );
      }

      return existing[0];
    }

    if (!input) {
      throw new Error('WooCommerce Store credentials are required');
    }

    const created = await this.stores.create(this.validateStoreInput(input));
    return this.requirePilotStore(identity.tenantId, created.id);
  }

  private async activatePilotStore(
    identity: PilotIdentity,
    storeId: string
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.store.findFirst({
        where: {
          id: storeId,
          tenantId: identity.tenantId,
          deletedAt: null,
        },
        select: { status: true },
      });

      if (current?.status === StoreStatus.ACTIVE) {
        return;
      }

      if (current?.status !== StoreStatus.PENDING) {
        throw new Error(
          'Pilot Store cannot be activated from its current state'
        );
      }

      const updated = await transaction.store.updateMany({
        where: {
          id: storeId,
          tenantId: identity.tenantId,
          status: StoreStatus.PENDING,
          deletedAt: null,
          webhookSecretEncrypted: { not: null },
          webhookEndpointKey: { not: null },
        },
        data: { status: StoreStatus.ACTIVE },
      });

      if (updated.count !== 1) {
        throw new Error('Pilot Store activation failed closed');
      }

      await transaction.auditLog.create({
        data: {
          id: `aud_${randomUUID()}`,
          tenantId: identity.tenantId,
          userId: identity.userId,
          action: 'store.pilot_activated',
          entityType: 'Store',
          entityId: storeId,
          metadata: { status: StoreStatus.ACTIVE },
        },
        select: { id: true },
      });
    });
  }

  private async validateStoredConnection(
    store: PilotStoreRecord
  ): Promise<void> {
    await this.woocommerceClient(store).validateCredentials();
  }

  private woocommerceClient(store: PilotStoreRecord): WooCommerceClient {
    return new WooCommerceClient({
      storeUrl: store.baseUrl,
      consumerKey: this.encryption.decrypt(store.consumerKeyEncrypted),
      consumerSecret: this.encryption.decrypt(store.consumerSecretEncrypted),
      resilience: this.configuration.woocommerce.rest,
    });
  }

  private async pilotStores(tenantId: string): Promise<PilotStoreRecord[]> {
    return this.prisma.store.findMany({
      where: { tenantId },
      select: {
        id: true,
        tenantId: true,
        baseUrl: true,
        status: true,
        consumerKeyEncrypted: true,
        consumerSecretEncrypted: true,
        webhookSecretEncrypted: true,
        webhookEndpointKey: true,
        deletedAt: true,
      },
    });
  }

  private async requirePilotStore(
    tenantId: string,
    storeId: string
  ): Promise<PilotStoreRecord> {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, tenantId, deletedAt: null },
      select: {
        id: true,
        tenantId: true,
        baseUrl: true,
        status: true,
        consumerKeyEncrypted: true,
        consumerSecretEncrypted: true,
        webhookSecretEncrypted: true,
        webhookEndpointKey: true,
        deletedAt: true,
      },
    });

    if (!store) {
      throw new Error('Pilot Store was not found');
    }

    return store;
  }

  private async linkedTelegramContext(
    identity: PilotIdentity,
    storeId: string
  ): Promise<LinkedTelegramContext | undefined> {
    const account = await this.prisma.telegramAccount.findUnique({
      where: { userId: identity.userId },
      select: {
        telegramUserId: true,
        deletedAt: true,
        chatAuthorizations: {
          where: {
            revokedAt: null,
            chatType: 'PRIVATE',
            activeTenantId: identity.tenantId,
            activeStoreId: storeId,
          },
          select: { telegramChatId: true },
        },
      },
    });

    return account &&
      account.deletedAt === null &&
      account.chatAuthorizations.length === 1
      ? {
          telegramUserId: account.telegramUserId,
          telegramChatId: account.chatAuthorizations[0]!.telegramChatId,
        }
      : undefined;
  }

  private async pollForProjectedOrder(
    tenantId: string,
    storeId: string
  ): Promise<boolean> {
    const deadline =
      Date.now() + this.configuration.pilot.readinessTimeoutSeconds * 1000;

    do {
      const order = await this.prisma.order.findFirst({
        where: {
          tenantId,
          storeId,
          remoteDeletedAt: null,
        },
        select: { id: true },
      });

      if (order) {
        return true;
      }

      if (Date.now() >= deadline) {
        return false;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);

    return false;
  }

  private runAsPilot<T>(
    identity: PilotIdentity,
    callback: () => Promise<T>
  ): Promise<T> {
    return this.requestContext.run(PILOT_CONTEXT_REQUEST_ID, () => {
      this.tenantContext.set({
        tenantId: identity.tenantId,
        userId: identity.userId,
        membershipRole: MembershipRole.OWNER,
      });
      return callback();
    });
  }

  private webhookDeliveryUrl(origin: string, endpointKey: string): string {
    return `${origin}/api/webhooks/woocommerce/${encodeURIComponent(endpointKey)}`;
  }

  private normalizeIdentity(input: PilotIdentityInput): PilotIdentityInput {
    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName.trim();
    const tenantName = input.tenantName.trim();

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 320 ||
      displayName.length === 0 ||
      displayName.length > 255 ||
      tenantName.length === 0 ||
      tenantName.length > 255
    ) {
      throw new Error('Pilot identity details are invalid');
    }

    return { email, displayName, tenantName };
  }

  private validateStoreInput(input: PilotStoreInput): PilotStoreInput {
    const name = input.name.trim();
    const storeUrl = input.storeUrl.trim().replace(/\/+$/, '');
    let parsed: URL;

    try {
      parsed = new URL(storeUrl);
    } catch {
      throw new Error('WooCommerce Store URL must use HTTPS');
    }

    if (
      name.length === 0 ||
      name.length > 100 ||
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      input.consumerKey.length === 0 ||
      input.consumerSecret.length === 0
    ) {
      throw new Error('WooCommerce Store details are invalid');
    }

    return {
      name,
      storeUrl,
      consumerKey: input.consumerKey,
      consumerSecret: input.consumerSecret,
    };
  }

  private check(
    key: PilotReadinessCheckKey,
    label: string,
    pass: boolean,
    action: string
  ): PilotReadinessCheck {
    return { key, label, pass, action };
  }
}
