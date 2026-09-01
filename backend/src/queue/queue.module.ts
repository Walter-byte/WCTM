import { forwardRef, Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module';
import { OrdersModule } from '../orders/orders.module';
import { TelegramModule } from '../telegram/telegram.module';
import { TenantContextModule } from '../tenant/tenant-context.module';
import { QueueRuntimeService } from './queue-runtime.service';
import { OrderNotificationProcessor } from './order-notification.processor';
import { OrderNotificationScheduler } from './order-notification.scheduler';
import { ReferenceJobProducer } from './reference-job.producer';
import { ReferenceProcessor } from './reference.processor';
import { WooCommerceWebhookJobProducer } from './woocommerce-webhook-job.producer';
import { WooCommerceWebhookProcessor } from './woocommerce-webhook.processor';
import { InventoryBootstrapProcessor } from './inventory-bootstrap.processor';
import { InventoryBootstrapScheduler } from './inventory-bootstrap.scheduler';
import { InventoryNotificationProcessor } from './inventory-notification.processor';
import { InventoryNotificationScheduler } from './inventory-notification.scheduler';

@Module({
  imports: [
    TenantContextModule,
    OrdersModule,
    InventoryModule,
    forwardRef(() => TelegramModule),
  ],
  providers: [
    ReferenceProcessor,
    OrderNotificationProcessor,
    OrderNotificationScheduler,
    WooCommerceWebhookProcessor,
    InventoryBootstrapProcessor,
    InventoryBootstrapScheduler,
    InventoryNotificationProcessor,
    InventoryNotificationScheduler,
    QueueRuntimeService,
    ReferenceJobProducer,
    WooCommerceWebhookJobProducer,
  ],
  exports: [
    QueueRuntimeService,
    ReferenceJobProducer,
    WooCommerceWebhookJobProducer,
    InventoryBootstrapScheduler,
  ],
})
export class QueueModule {}
