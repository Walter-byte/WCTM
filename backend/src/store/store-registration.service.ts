import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, StoreStatus } from '@prisma/client';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { AuditService } from '../common/audit/audit.service';
import { EncryptionService } from '../common/encryption/encryption.service';
import { ApplicationConfigService } from '../config/application-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantScopedPrismaService } from '../tenant/tenant-scoped-prisma.service';
import { TenantContextService } from '../tenant/tenant-context.service';
import {
  type WooCommerceErrorCategory,
  WooCommerceClient,
} from '../woocommerce/client/woocommerce.client';
import { PluginRegistrationRateLimiter } from './plugin-registration-rate-limiter.service';

const INVALID_REGISTRATION_MESSAGE =
  'Plugin registration is invalid or already completed';
const VERIFICATION_FAILED_MESSAGE = 'Plugin registration could not be verified';
const REGISTRATION_UNAVAILABLE_MESSAGE =
  'Plugin registration is temporarily unavailable';
const INVALID_PLUGIN_CREDENTIAL_MESSAGE = 'Plugin credential is invalid';
const WEBHOOK_VERIFICATION_FAILED_MESSAGE =
  'Required WooCommerce webhooks could not be verified';
const TRANSIENT_CATEGORIES = new Set<WooCommerceErrorCategory>([
  'transport',
  'timeout',
  'rate-limited',
]);

export interface RegistrationTokenResult {
  token: string;
  expiresAt: Date;
}

export interface PluginRegistrationResult {
  pluginCredential: string;
  storeId: string;
  webhookSecret?: string;
  webhookEndpointKey?: string;
}

export interface WebhookCredentialsResult {
  provisioned: true;
  rotated: boolean;
  webhookEndpointKey: string;
  webhookSecret?: string;
}

export interface StoreConnectionHealthResult {
  status: StoreStatus;
  lastSeenAt: Date | null;
  lastHealthyAt: Date | null;
  registered: boolean;
}

export interface PluginConnectionHealthResult {
  status: StoreStatus;
  healthy: true;
}

@Injectable()
export class StoreRegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantPrisma: TenantScopedPrismaService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly configuration: ApplicationConfigService,
    private readonly rateLimiter: PluginRegistrationRateLimiter,
    private readonly tenantContext: TenantContextService
  ) {}

  async issueToken(storeId: string): Promise<RegistrationTokenResult> {
    const token = `reg_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(
      Date.now() + this.configuration.pluginRegistration.tokenTtlSeconds * 1000
    );
    const issued = await this.tenantPrisma.issueStoreRegistrationToken(
      storeId,
      this.hash(token),
      expiresAt
    );

    if (!issued) {
      throw new NotFoundException('Store was not found');
    }

    await this.audit.record({
      action: 'store.registration_token_issued',
      entity: 'Store',
      entityId: storeId,
    });

    return { token, expiresAt };
  }

  async register(
    token: string,
    clientIp: string
  ): Promise<PluginRegistrationResult> {
    const tokenHash = this.hash(token);

    await this.rateLimiter.assertAllowed(clientIp, tokenHash);

    return this.prisma.$transaction(
      (transaction) => this.finalize(transaction, tokenHash),
      {
        timeout: this.configuration.woocommerce.rest.totalTimeoutMs + 5000,
      }
    );
  }

  async connectionHealth(
    storeId: string
  ): Promise<StoreConnectionHealthResult> {
    const health = await this.tenantPrisma.findStoreConnectionHealth(storeId);

    if (!health) {
      throw new NotFoundException('Store was not found');
    }

    return {
      status: health.status,
      lastSeenAt: health.lastSeenAt,
      lastHealthyAt: health.lastHealthyAt,
      registered: health.pluginRegisteredAt !== null,
    };
  }

  async confirmPluginConnection(
    pluginCredential: string
  ): Promise<PluginConnectionHealthResult> {
    const pluginSecretHash = this.hash(pluginCredential);
    const candidates = await this.prisma.store.findMany({
      where: {
        pluginSecretHash,
        pluginRegisteredAt: { not: null },
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: {
        id: true,
        tenantId: true,
        baseUrl: true,
        status: true,
        consumerKeyEncrypted: true,
        consumerSecretEncrypted: true,
        pluginSecretHash: true,
        webhookSecretEncrypted: true,
        webhookEndpointKey: true,
      },
      take: 2,
    });
    const store = candidates.length === 1 ? candidates[0] : undefined;

    if (
      !store?.pluginSecretHash ||
      !this.hashesEqual(store.pluginSecretHash, pluginSecretHash) ||
      !store.webhookSecretEncrypted ||
      !store.webhookEndpointKey
    ) {
      throw new BadRequestException(INVALID_PLUGIN_CREDENTIAL_MESSAGE);
    }

    const webhooksVerified = await new WooCommerceClient({
      storeUrl: store.baseUrl,
      consumerKey: this.encryption.decrypt(store.consumerKeyEncrypted),
      consumerSecret: this.encryption.decrypt(store.consumerSecretEncrypted),
      resilience: this.configuration.woocommerce.rest,
    }).hasRequiredOrderWebhooksForEndpointKey(store.webhookEndpointKey);

    if (!webhooksVerified) {
      throw new BadRequestException(WEBHOOK_VERIFICATION_FAILED_MESSAGE);
    }

    const healthyAt = new Date();
    const updated = await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.store.updateMany({
        where: {
          id: store.id,
          tenantId: store.tenantId,
          pluginSecretHash,
          pluginRegisteredAt: { not: null },
          deletedAt: null,
          tenant: { deletedAt: null },
        },
        data: {
          status: StoreStatus.ACTIVE,
          lastSeenAt: healthyAt,
          lastHealthyAt: healthyAt,
        },
      });

      if (result.count !== 1) {
        return false;
      }

      await transaction.auditLog.create({
        data: {
          id: `aud_${randomUUID()}`,
          tenantId: store.tenantId,
          userId: null,
          action: 'store.plugin_connection_healthy',
          entityType: 'Store',
          entityId: store.id,
          metadata: { status: StoreStatus.ACTIVE },
        },
        select: { id: true },
      });

      return true;
    });

    if (!updated) {
      throw new ServiceUnavailableException(REGISTRATION_UNAVAILABLE_MESSAGE);
    }

    return { status: StoreStatus.ACTIVE, healthy: true };
  }

  provisionWebhookCredentials(
    storeId: string,
    rotate: boolean
  ): Promise<WebhookCredentialsResult> {
    const { tenantId, userId } = this.tenantContext.active;

    return this.prisma.$transaction(async (transaction) => {
      const store = await transaction.store.findFirst({
        where: {
          id: storeId,
          tenantId,
          deletedAt: null,
        },
        select: {
          id: true,
          webhookSecretEncrypted: true,
          webhookEndpointKey: true,
        },
      });

      if (!store) {
        throw new NotFoundException('Store was not found');
      }

      if (!rotate && store.webhookSecretEncrypted && store.webhookEndpointKey) {
        return {
          provisioned: true,
          rotated: false,
          webhookEndpointKey: store.webhookEndpointKey,
        };
      }

      const credentials = this.generateWebhookCredentials();
      const updated = await transaction.store.updateMany({
        where: {
          id: storeId,
          tenantId,
          deletedAt: null,
          ...(rotate
            ? {}
            : {
                OR: [
                  { webhookSecretEncrypted: null },
                  { webhookSecretEncrypted: '' },
                  { webhookEndpointKey: null },
                ],
              }),
        },
        data: {
          webhookSecretEncrypted: this.encryption.encrypt(
            credentials.webhookSecret
          ),
          webhookEndpointKey: credentials.webhookEndpointKey,
        },
      });

      if (updated.count !== 1) {
        const current = await transaction.store.findFirst({
          where: {
            id: storeId,
            tenantId,
            deletedAt: null,
          },
          select: { webhookEndpointKey: true },
        });

        if (!current?.webhookEndpointKey) {
          throw new ServiceUnavailableException(
            'Webhook credentials are temporarily unavailable'
          );
        }

        return {
          provisioned: true,
          rotated: false,
          webhookEndpointKey: current.webhookEndpointKey,
        };
      }

      await transaction.auditLog.create({
        data: {
          id: `aud_${randomUUID()}`,
          tenantId,
          userId,
          action: 'store.webhook_credentials_provisioned',
          entityType: 'Store',
          entityId: storeId,
          metadata: { rotated: rotate },
        },
        select: { id: true },
      });

      return {
        provisioned: true,
        rotated: rotate,
        webhookEndpointKey: credentials.webhookEndpointKey,
        webhookSecret: credentials.webhookSecret,
      };
    });
  }

  private async finalize(
    transaction: Prisma.TransactionClient,
    tokenHash: string
  ): Promise<PluginRegistrationResult> {
    const now = new Date();
    const store = await transaction.store.findFirst({
      where: {
        registrationTokenHash: tokenHash,
        deletedAt: null,
      },
      select: {
        id: true,
        tenantId: true,
        baseUrl: true,
        status: true,
        consumerKeyEncrypted: true,
        consumerSecretEncrypted: true,
        registrationTokenHash: true,
        registrationTokenExpiresAt: true,
        registrationTokenConsumedAt: true,
        webhookSecretEncrypted: true,
        webhookEndpointKey: true,
        lastHealthyAt: true,
      },
    });

    if (
      !store?.registrationTokenHash ||
      !this.hashesEqual(store.registrationTokenHash, tokenHash) ||
      !store.registrationTokenExpiresAt ||
      store.registrationTokenExpiresAt <= now ||
      store.registrationTokenConsumedAt
    ) {
      throw new BadRequestException(INVALID_REGISTRATION_MESSAGE);
    }

    const connection = await new WooCommerceClient({
      storeUrl: store.baseUrl,
      consumerKey: this.encryption.decrypt(store.consumerKeyEncrypted),
      consumerSecret: this.encryption.decrypt(store.consumerSecretEncrypted),
      resilience: this.configuration.woocommerce.rest,
    }).testConnection();

    if (!connection.success) {
      if (
        connection.category &&
        TRANSIENT_CATEGORIES.has(connection.category)
      ) {
        throw new ServiceUnavailableException(REGISTRATION_UNAVAILABLE_MESSAGE);
      }

      throw new BadRequestException(VERIFICATION_FAILED_MESSAGE);
    }

    const finalizedAt = new Date();
    const pluginCredential = `plg_${randomBytes(32).toString('base64url')}`;
    const needsWebhookCredentials =
      !store.webhookSecretEncrypted || !store.webhookEndpointKey;
    const webhookCredentials = needsWebhookCredentials
      ? this.generateWebhookCredentials()
      : undefined;
    const updated = await transaction.store.updateMany({
      where: {
        id: store.id,
        registrationTokenHash: tokenHash,
        registrationTokenConsumedAt: null,
        registrationTokenExpiresAt: { gt: finalizedAt },
        deletedAt: null,
      },
      data: {
        pluginSecretHash: this.hash(pluginCredential),
        pluginRegisteredAt: finalizedAt,
        registrationTokenConsumedAt: finalizedAt,
        lastSeenAt: finalizedAt,
        status:
          store.status === StoreStatus.ACTIVE && store.lastHealthyAt
            ? StoreStatus.ACTIVE
            : StoreStatus.PENDING,
        ...(webhookCredentials
          ? {
              webhookSecretEncrypted: this.encryption.encrypt(
                webhookCredentials.webhookSecret
              ),
              webhookEndpointKey: webhookCredentials.webhookEndpointKey,
            }
          : {}),
      },
    });

    if (updated.count !== 1) {
      throw new BadRequestException(INVALID_REGISTRATION_MESSAGE);
    }

    await transaction.auditLog.create({
      data: {
        id: `aud_${randomUUID()}`,
        tenantId: store.tenantId,
        userId: null,
        action: 'store.plugin_registered',
        entityType: 'Store',
        entityId: store.id,
        metadata: {
          status:
            store.status === StoreStatus.ACTIVE && store.lastHealthyAt
              ? StoreStatus.ACTIVE
              : StoreStatus.PENDING,
        },
      },
      select: { id: true },
    });

    return {
      pluginCredential,
      storeId: store.id,
      ...(webhookCredentials
        ? {
            webhookSecret: webhookCredentials.webhookSecret,
            webhookEndpointKey: webhookCredentials.webhookEndpointKey,
          }
        : {}),
    };
  }

  private generateWebhookCredentials(): {
    webhookSecret: string;
    webhookEndpointKey: string;
  } {
    return {
      webhookSecret: randomBytes(32).toString('base64url'),
      webhookEndpointKey: `whk_${randomBytes(32).toString('base64url')}`,
    };
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private hashesEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');

    return (
      leftBuffer.length === rightBuffer.length &&
      timingSafeEqual(leftBuffer, rightBuffer)
    );
  }
}
