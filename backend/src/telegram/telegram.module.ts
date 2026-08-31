import { Module } from '@nestjs/common';

import { EncryptionModule } from '../common/encryption/encryption.module';
import { OrdersModule } from '../orders/orders.module';
import { BotApiKeyGuard } from './guards/bot-api-key.guard';
import { TelegramInternalController } from './telegram-internal.controller';
import { TelegramDeliveryClient } from './telegram-delivery.client';
import { TelegramLinkingService } from './telegram-linking.service';
import { TelegramOrderService } from './telegram-order.service';
import { TelegramSettingsService } from './telegram-settings.service';

@Module({
  imports: [EncryptionModule, OrdersModule],
  controllers: [TelegramInternalController],
  providers: [
    BotApiKeyGuard,
    TelegramDeliveryClient,
    TelegramLinkingService,
    TelegramOrderService,
    TelegramSettingsService,
  ],
  exports: [
    TelegramDeliveryClient,
    TelegramLinkingService,
    TelegramOrderService,
    TelegramSettingsService,
  ],
})
export class TelegramModule {}
