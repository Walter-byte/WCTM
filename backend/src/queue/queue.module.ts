import { Module } from '@nestjs/common';

import { OrdersModule } from '../orders/orders.module';
import { TenantContextModule } from '../tenant/tenant-context.module';
import { QueueRuntimeService } from './queue-runtime.service';
import { ReferenceJobProducer } from './reference-job.producer';
import { ReferenceProcessor } from './reference.processor';
import { WooCommerceWebhookJobProducer } from './woocommerce-webhook-job.producer';
import { WooCommerceWebhookProcessor } from './woocommerce-webhook.processor';

@Module({
  imports: [TenantContextModule, OrdersModule],
  providers: [
    ReferenceProcessor,
    WooCommerceWebhookProcessor,
    QueueRuntimeService,
    ReferenceJobProducer,
    WooCommerceWebhookJobProducer,
  ],
  exports: [
    QueueRuntimeService,
    ReferenceJobProducer,
    WooCommerceWebhookJobProducer,
  ],
})
export class QueueModule {}
