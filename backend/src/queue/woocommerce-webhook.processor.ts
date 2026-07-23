import { Injectable } from '@nestjs/common';
import { WebhookEventStatus } from '@prisma/client';
import { type Job, UnrecoverableError } from 'bullmq';

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

const WEBHOOK_EVENT_ID_PATTERN = /^evt_[A-Za-z0-9-]{1,60}$/;
const TENANT_ID_PATTERN = /^ten_[A-Za-z0-9-]{1,60}$/;
const STORE_ID_PATTERN = /^sto_[A-Za-z0-9-]{1,60}$/;

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
  constructor(private readonly prisma: PrismaService) {}

  async process(
    job: Job<
      WooCommerceWebhookJobData,
      WooCommerceWebhookJobResult,
      typeof WOOCOMMERCE_WEBHOOK_JOB_NAME
    >
  ): Promise<WooCommerceWebhookJobResult> {
    validateWooCommerceWebhookJobData(job.data);

    const processing = await this.prisma.webhookEvent.updateMany({
      where: {
        id: job.data.webhookEventId,
        tenantId: job.data.tenantId,
        storeId: job.data.storeId,
        status: {
          in: [
            WebhookEventStatus.RECEIVED,
            WebhookEventStatus.QUEUED,
            WebhookEventStatus.PROCESSING,
          ],
        },
      },
      data: {
        status: WebhookEventStatus.PROCESSING,
        processingAt: new Date(),
      },
    });

    if (processing.count !== 1) {
      throw new UnrecoverableError(
        'WooCommerce webhook event is unavailable for processing'
      );
    }

    const completed = await this.prisma.webhookEvent.updateMany({
      where: {
        id: job.data.webhookEventId,
        tenantId: job.data.tenantId,
        storeId: job.data.storeId,
        status: WebhookEventStatus.PROCESSING,
      },
      data: {
        status: WebhookEventStatus.COMPLETED,
        completedAt: new Date(),
      },
    });

    if (completed.count !== 1) {
      throw new Error('WooCommerce webhook lifecycle update failed');
    }

    return {
      webhookEventId: job.data.webhookEventId,
      tenantId: job.data.tenantId,
      storeId: job.data.storeId,
      processed: true,
    };
  }

  async markFailed(value: unknown): Promise<void> {
    validateWooCommerceWebhookJobData(value);

    await this.prisma.webhookEvent.updateMany({
      where: {
        id: value.webhookEventId,
        tenantId: value.tenantId,
        storeId: value.storeId,
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
        failedAt: new Date(),
      },
    });
  }
}
