import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, StoreStatus, WebhookEventStatus } from '@prisma/client';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { EncryptionService } from '../common/encryption/encryption.service';
import { StructuredLoggerService } from '../common/logging/structured-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { WooCommerceWebhookJobProducer } from '../queue/woocommerce-webhook-job.producer';
import type { WebhookRequestHeaders } from './woocommerce-webhook.controller';

const GENERIC_NOT_FOUND_MESSAGE = 'Webhook endpoint was not found';
const MALFORMED_REQUEST_MESSAGE = 'Webhook request is malformed';
const INVALID_SIGNATURE_MESSAGE = 'Webhook signature is invalid';
const SIGNATURE_HEADER = 'x-wc-webhook-signature';
const WEBHOOK_ID_HEADER = 'x-wc-webhook-id';
const DELIVERY_ID_HEADER = 'x-wc-webhook-delivery-id';
const TOPIC_HEADER = 'x-wc-webhook-topic';
const HEADER_VALUE_PATTERN = /^[\x21-\x7e]+$/;

interface RequiredWebhookHeaders {
  signature: Buffer;
  webhookId: string;
  deliveryId: string;
  topic: string;
}

interface RoutedStore {
  id: string;
  tenantId: string;
  webhookSecretEncrypted: string | null;
}

interface WebhookEventRecord {
  id: string;
  tenantId: string;
  storeId: string;
  status: WebhookEventStatus;
}

export function signaturesMatch(
  rawBody: Buffer,
  secret: string,
  suppliedSignature: Buffer
): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest();

  return (
    expected.length === suppliedSignature.length &&
    timingSafeEqual(expected, suppliedSignature)
  );
}

@Injectable()
export class WooCommerceWebhookIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly jobs: WooCommerceWebhookJobProducer,
    private readonly logger: StructuredLoggerService
  ) {}

  async receive(
    endpointKey: string,
    headers: WebhookRequestHeaders,
    rawBody: unknown
  ): Promise<{ received: true }> {
    const store = await this.resolveStore(endpointKey);
    const requiredHeaders = this.requireHeaders(headers);
    const body = this.requireRawBody(rawBody);
    const secret = this.decryptSecret(store.webhookSecretEncrypted);

    if (!signaturesMatch(body, secret, requiredHeaders.signature)) {
      this.logger.warn(
        'WooCommerce webhook signature rejected',
        {
          endpointRoute: this.truncatedEndpoint(endpointKey),
          storeId: store.id,
        },
        WooCommerceWebhookIngestionService.name
      );
      throw new UnauthorizedException(INVALID_SIGNATURE_MESSAGE);
    }

    const payload = this.parsePayload(body);
    const event = await this.persistOrFind(store, requiredHeaders, payload);

    if (event.status !== WebhookEventStatus.RECEIVED) {
      this.logger.log(
        'Duplicate WooCommerce webhook acknowledged',
        {
          webhookEventId: event.id,
          tenantId: event.tenantId,
          storeId: event.storeId,
          status: event.status,
        },
        WooCommerceWebhookIngestionService.name
      );
      return { received: true };
    }

    try {
      await this.jobs.enqueue({
        webhookEventId: event.id,
        tenantId: event.tenantId,
        storeId: event.storeId,
      });
    } catch {
      this.logger.error(
        'WooCommerce webhook enqueue failed',
        {
          webhookEventId: event.id,
          tenantId: event.tenantId,
          storeId: event.storeId,
        },
        WooCommerceWebhookIngestionService.name
      );
      throw new ServiceUnavailableException(
        'Webhook delivery is temporarily unavailable'
      );
    }

    await this.prisma.webhookEvent.updateMany({
      where: {
        id: event.id,
        tenantId: event.tenantId,
        storeId: event.storeId,
        status: WebhookEventStatus.RECEIVED,
      },
      data: {
        status: WebhookEventStatus.QUEUED,
        queuedAt: new Date(),
      },
    });

    return { received: true };
  }

  private resolveStore(endpointKey: string): Promise<RoutedStore> {
    return this.prisma.store
      .findFirst({
        where: {
          webhookEndpointKey: endpointKey,
          status: StoreStatus.ACTIVE,
          deletedAt: null,
          tenant: { deletedAt: null },
        },
        select: {
          id: true,
          tenantId: true,
          webhookSecretEncrypted: true,
        },
      })
      .then((store) => {
        if (!store) {
          throw new NotFoundException(GENERIC_NOT_FOUND_MESSAGE);
        }

        return store;
      });
  }

  private requireHeaders(
    headers: WebhookRequestHeaders
  ): RequiredWebhookHeaders {
    const signatureValue = this.singleHeader(headers, SIGNATURE_HEADER);

    if (!signatureValue || !/^[A-Za-z0-9+/]{43}=$/.test(signatureValue)) {
      throw new UnauthorizedException(INVALID_SIGNATURE_MESSAGE);
    }

    const signature = Buffer.from(signatureValue, 'base64');

    if (signature.length !== 32) {
      throw new UnauthorizedException(INVALID_SIGNATURE_MESSAGE);
    }

    return {
      signature,
      webhookId: this.requireIdentityHeader(headers, WEBHOOK_ID_HEADER),
      deliveryId: this.requireIdentityHeader(headers, DELIVERY_ID_HEADER),
      topic: this.requireIdentityHeader(headers, TOPIC_HEADER),
    };
  }

  private requireIdentityHeader(
    headers: WebhookRequestHeaders,
    name: string
  ): string {
    const value = this.singleHeader(headers, name);

    if (!value || value.length > 191 || !HEADER_VALUE_PATTERN.test(value)) {
      throw new BadRequestException(MALFORMED_REQUEST_MESSAGE);
    }

    return value;
  }

  private singleHeader(
    headers: WebhookRequestHeaders,
    name: string
  ): string | undefined {
    const value = headers[name];

    return typeof value === 'string' ? value : undefined;
  }

  private requireRawBody(rawBody: unknown): Buffer {
    if (!Buffer.isBuffer(rawBody)) {
      throw new BadRequestException(MALFORMED_REQUEST_MESSAGE);
    }

    return rawBody;
  }

  private decryptSecret(encryptedSecret: string | null): string {
    if (!encryptedSecret) {
      throw new UnauthorizedException(INVALID_SIGNATURE_MESSAGE);
    }

    try {
      return this.encryption.decrypt(encryptedSecret);
    } catch {
      throw new UnauthorizedException(INVALID_SIGNATURE_MESSAGE);
    }
  }

  private parsePayload(
    rawBody: Buffer
  ): Prisma.InputJsonValue | Prisma.NullTypes.JsonNull {
    try {
      const parsed: unknown = JSON.parse(rawBody.toString('utf8'));

      return parsed === null
        ? Prisma.JsonNull
        : (parsed as Prisma.InputJsonValue);
    } catch {
      throw new BadRequestException(MALFORMED_REQUEST_MESSAGE);
    }
  }

  private async persistOrFind(
    store: RoutedStore,
    headers: RequiredWebhookHeaders,
    payload: Prisma.InputJsonValue | Prisma.NullTypes.JsonNull
  ): Promise<WebhookEventRecord> {
    try {
      return await this.prisma.webhookEvent.create({
        data: {
          id: `evt_${randomUUID()}`,
          tenantId: store.tenantId,
          storeId: store.id,
          webhookId: headers.webhookId,
          deliveryId: headers.deliveryId,
          dedupeKey: headers.deliveryId,
          topic: headers.topic,
          payload,
          status: WebhookEventStatus.RECEIVED,
          receivedAt: new Date(),
        },
        select: {
          id: true,
          tenantId: true,
          storeId: true,
          status: true,
        },
      });
    } catch (error: unknown) {
      if (!this.isUniqueConstraintViolation(error)) {
        throw error;
      }

      const existing = await this.prisma.webhookEvent.findUnique({
        where: {
          storeId_dedupeKey: {
            storeId: store.id,
            dedupeKey: headers.deliveryId,
          },
        },
        select: {
          id: true,
          tenantId: true,
          storeId: true,
          status: true,
        },
      });

      if (!existing || existing.tenantId !== store.tenantId) {
        throw new ServiceUnavailableException(
          'Webhook delivery is temporarily unavailable'
        );
      }

      return existing;
    }
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    return (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'P2002'
    );
  }

  private truncatedEndpoint(endpointKey: string): string {
    return endpointKey.length <= 8
      ? '[redacted]'
      : `${endpointKey.slice(0, 8)}…`;
  }
}
