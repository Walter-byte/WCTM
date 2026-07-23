import { Injectable } from '@nestjs/common';
import { WebhookEventStatus } from '@prisma/client';
import { type Job, UnrecoverableError } from 'bullmq';

import {
  OrderProjectionFailure,
  OrderProjectionService,
} from '../orders/order-projection.service';
import { PrismaService } from '../prisma/prisma.service';
import { WOOCOMMERCE_WEBHOOK_JOB_NAME } from './queue.constants';

export interface WooCommerceWebhookJobData {
  webhookEventId: string;
  tenantId: string;
  storeId: string;
}

export interface WooCommerceWebhookJobResult {
  webhookEventId: string;
  tenantId: string;
  storeId: string;
  processed: true;
}

interface ClaimedWebhookEvent {
  id: string;
  topic: string;
  payload: import('@prisma/client').Prisma.JsonValue;
  receivedAt: Date;
  store: {
    id: string;
    tenantId: string;
    baseUrl: string;
    consumerKeyEncrypted: string;
    consumerSecretEncrypted: string;
  };
}

interface FailureDiagnostic {
  category:
    | 'auth'
    | 'not-found'
    | 'transport'
    | 'rate-limited'
    | 'timeout'
    | 'unexpected';
  message: string;
}

const WEBHOOK_EVENT_ID_PATTERN = /^evt_[A-Za-z0-9-]{1,60}$/;
const TENANT_ID_PATTERN = /^ten_[A-Za-z0-9-]{1,60}$/;
const STORE_ID_PATTERN = /^sto_[A-Za-z0-9-]{1,60}$/;
const MAX_FAILURE_MESSAGE_LENGTH = 191;

export const WEBHOOK_PROCESSING_LEASE_TTL_MS = 30_000;

export function validateWooCommerceWebhookJobData(
  value: unknown
): asserts value is WooCommerceWebhookJobData {
  if (value === null || typeof value !== 'object') {
    throw new UnrecoverableError(
      'WooCommerce webhook job payload must be an object'
    );
  }

  const data = value as Partial<WooCommerceWebhookJobData>;

  if (
    typeof data.webhookEventId !== 'string' ||
    !WEBHOOK_EVENT_ID_PATTERN.test(data.webhookEventId)
  ) {
    throw new UnrecoverableError(
      'WooCommerce webhook event identity is required and must be valid'
    );
  }

  if (
    typeof data.tenantId !== 'string' ||
    !TENANT_ID_PATTERN.test(data.tenantId)
  ) {
    throw new UnrecoverableError(
      'WooCommerce webhook tenant identity is required and must be valid'
    );
  }

  if (
    typeof data.storeId !== 'string' ||
    !STORE_ID_PATTERN.test(data.storeId)
  ) {
    throw new UnrecoverableError(
      'WooCommerce webhook Store identity is required and must be valid'
    );
  }
}

@Injectable()
export class WooCommerceWebhookProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orderProjection: OrderProjectionService
  ) {}

  async process(
    job: Job<
      WooCommerceWebhookJobData,
      WooCommerceWebhookJobResult,
      typeof WOOCOMMERCE_WEBHOOK_JOB_NAME
    >
  ): Promise<WooCommerceWebhookJobResult> {
    validateWooCommerceWebhookJobData(job.data);

    const claimedAt = new Date();
    const leaseCutoff = new Date(
      claimedAt.getTime() - WEBHOOK_PROCESSING_LEASE_TTL_MS
    );
    const claimed = await this.prisma.webhookEvent.updateMany({
      where: {
        id: job.data.webhookEventId,
        OR: [
          { status: WebhookEventStatus.QUEUED },
          {
            status: WebhookEventStatus.PROCESSING,
            processingStartedAt: { lte: leaseCutoff },
          },
        ],
      },
      data: {
        status: WebhookEventStatus.PROCESSING,
        processingStartedAt: claimedAt,
        processingAttemptCount: { increment: 1 },
      },
    });

    if (claimed.count !== 1) {
      return this.resolveUnclaimed(job.data.webhookEventId);
    }

    const event = await this.loadClaimedEvent(job.data.webhookEventId);

    if (!event) {
      throw new UnrecoverableError(
        'WooCommerce webhook event is unavailable for processing'
      );
    }

    try {
      await this.orderProjection.project(event);
    } catch (error: unknown) {
      const diagnostic = this.failureDiagnostic(error);
      const retryable =
        error instanceof OrderProjectionFailure ? error.retryable : true;

      if (retryable) {
        await this.releaseForRetry(event.id, claimedAt, diagnostic);
        throw error instanceof Error
          ? error
          : new Error('WooCommerce webhook processing failed');
      }

      await this.failClaimed(event.id, claimedAt, diagnostic);
      throw new UnrecoverableError(diagnostic.message);
    }

    const completed = await this.prisma.webhookEvent.updateMany({
      where: {
        id: event.id,
        status: WebhookEventStatus.PROCESSING,
        processingStartedAt: claimedAt,
      },
      data: {
        status: WebhookEventStatus.COMPLETED,
        processingStartedAt: null,
        completedAt: new Date(),
        failureCategory: null,
        failureMessage: null,
        lastFailureAt: null,
      },
    });

    if (completed.count !== 1) {
      throw new Error('WooCommerce webhook lifecycle update failed');
    }

    return this.result(event);
  }

  async markFailed(value: unknown, error?: Error): Promise<void> {
    validateWooCommerceWebhookJobData(value);

    const diagnostic = this.failureDiagnostic(error);

    await this.prisma.webhookEvent.updateMany({
      where: {
        id: value.webhookEventId,
        status: {
          in: [
            WebhookEventStatus.RECEIVED,
            WebhookEventStatus.QUEUED,
            WebhookEventStatus.PROCESSING,
          ],
        },
      },
      data: {
        status: WebhookEventStatus.FAILED,
        processingStartedAt: null,
        failureCategory: diagnostic.category,
        failureMessage: diagnostic.message,
        lastFailureAt: new Date(),
        failedAt: new Date(),
      },
    });
  }

  private async resolveUnclaimed(
    webhookEventId: string
  ): Promise<WooCommerceWebhookJobResult> {
    const event = await this.prisma.webhookEvent.findUnique({
      where: { id: webhookEventId },
      select: {
        id: true,
        status: true,
        processingStartedAt: true,
        store: {
          select: {
            id: true,
            tenantId: true,
          },
        },
      },
    });

    if (
      event?.status === WebhookEventStatus.COMPLETED ||
      (event?.status === WebhookEventStatus.PROCESSING &&
        event.processingStartedAt &&
        event.processingStartedAt.getTime() >
          Date.now() - WEBHOOK_PROCESSING_LEASE_TTL_MS)
    ) {
      return {
        webhookEventId: event.id,
        tenantId: event.store.tenantId,
        storeId: event.store.id,
        processed: true,
      };
    }

    if (event?.status === WebhookEventStatus.RECEIVED) {
      throw new Error('WooCommerce webhook event is not queued yet');
    }

    throw new UnrecoverableError(
      'WooCommerce webhook event is unavailable for processing'
    );
  }

  private loadClaimedEvent(
    webhookEventId: string
  ): Promise<ClaimedWebhookEvent | null> {
    return this.prisma.webhookEvent.findUnique({
      where: { id: webhookEventId },
      select: {
        id: true,
        topic: true,
        payload: true,
        receivedAt: true,
        store: {
          select: {
            id: true,
            tenantId: true,
            baseUrl: true,
            consumerKeyEncrypted: true,
            consumerSecretEncrypted: true,
          },
        },
      },
    });
  }

  private async releaseForRetry(
    webhookEventId: string,
    claimedAt: Date,
    diagnostic: FailureDiagnostic
  ): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: {
        id: webhookEventId,
        status: WebhookEventStatus.PROCESSING,
        processingStartedAt: claimedAt,
      },
      data: {
        status: WebhookEventStatus.QUEUED,
        processingStartedAt: null,
        failureCategory: diagnostic.category,
        failureMessage: diagnostic.message,
        lastFailureAt: new Date(),
      },
    });
  }

  private async failClaimed(
    webhookEventId: string,
    claimedAt: Date,
    diagnostic: FailureDiagnostic
  ): Promise<void> {
    await this.prisma.webhookEvent.updateMany({
      where: {
        id: webhookEventId,
        status: WebhookEventStatus.PROCESSING,
        processingStartedAt: claimedAt,
      },
      data: {
        status: WebhookEventStatus.FAILED,
        processingStartedAt: null,
        failureCategory: diagnostic.category,
        failureMessage: diagnostic.message,
        lastFailureAt: new Date(),
        failedAt: new Date(),
      },
    });
  }

  private failureDiagnostic(error: unknown): FailureDiagnostic {
    if (error instanceof OrderProjectionFailure) {
      return {
        category: error.category,
        message: error.code.slice(0, MAX_FAILURE_MESSAGE_LENGTH),
      };
    }

    return {
      category: 'unexpected',
      message: 'webhook-processing-failed',
    };
  }

  private result(event: ClaimedWebhookEvent): WooCommerceWebhookJobResult {
    return {
      webhookEventId: event.id,
      tenantId: event.store.tenantId,
      storeId: event.store.id,
      processed: true,
    };
  }
}
