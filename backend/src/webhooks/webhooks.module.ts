import { Module } from '@nestjs/common';

import { EncryptionModule } from '../common/encryption/encryption.module';
import { QueueModule } from '../queue/queue.module';
import { WooCommerceWebhookController } from './woocommerce-webhook.controller';
import { WooCommerceWebhookIngestionService } from './woocommerce-webhook-ingestion.service';

@Module({
  imports: [EncryptionModule, QueueModule],
  controllers: [WooCommerceWebhookController],
  providers: [WooCommerceWebhookIngestionService],
})
export class WebhooksModule {}
