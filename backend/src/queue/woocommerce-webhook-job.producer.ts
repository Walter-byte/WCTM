import { Injectable } from '@nestjs/common';

import { QueueRuntimeService } from './queue-runtime.service';
import {
  type WooCommerceWebhookJobData,
  validateWooCommerceWebhookJobData,
} from './woocommerce-webhook.processor';

export const webhookJobId = (webhookEventId: string): string =>
  `woocommerce-webhook-${webhookEventId}`;

@Injectable()
export class WooCommerceWebhookJobProducer {
  constructor(private readonly queueRuntime: QueueRuntimeService) {}

  async enqueue(data: WooCommerceWebhookJobData): Promise<{ jobId: string }> {
    validateWooCommerceWebhookJobData(data);
    const jobId = webhookJobId(data.webhookEventId);
    const job = await this.queueRuntime.addWooCommerceWebhookJob(data, jobId);

    return { jobId: String(job.id) };
  }
}
