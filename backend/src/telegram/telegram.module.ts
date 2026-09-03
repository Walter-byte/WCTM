import { forwardRef, Module } from '@nestjs/common';

import { EncryptionModule } from '../common/encryption/encryption.module';
import { TelegramInventoryService } from '../inventory/telegram-inventory.service';
import { OrdersModule } from '../orders/orders.module';
import { QueueModule } from '../queue/queue.module';
import { BotApiKeyGuard } from './guards/bot-api-key.guard';
import { TelegramInternalController } from './telegram-internal.controller';
import { TelegramDeliveryClient } from './telegram-delivery.client';
import { TelegramLinkingService } from './telegram-linking.service';
import { TelegramOrderService } from './telegram-order.service';
import { TelegramSearchReportService } from './telegram-search-report.service';
import { TelegramSettingsService } from './telegram-settings.service';

@Module({
  imports: [EncryptionModule, OrdersModule, forwardRef(() => QueueModule)],
  controllers: [TelegramInternalController],
  providers: [
    BotApiKeyGuard,
    TelegramDeliveryClient,
    TelegramLinkingService,
    TelegramOrderService,
    TelegramSettingsService,
    TelegramInventoryService,
    TelegramSearchReportService,
  ],
  exports: [
    TelegramDeliveryClient,
    TelegramLinkingService,
    TelegramOrderService,
    TelegramSettingsService,
    TelegramInventoryService,
    TelegramSearchReportService,
  ],
})
export class TelegramModule {}
