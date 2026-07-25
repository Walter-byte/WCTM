import { Module } from '@nestjs/common';

import { EncryptionModule } from '../common/encryption/encryption.module';
import { OrdersModule } from '../orders/orders.module';
import { BotApiKeyGuard } from './guards/bot-api-key.guard';
import { TelegramInternalController } from './telegram-internal.controller';
import { TelegramLinkingService } from './telegram-linking.service';
import { TelegramOrderService } from './telegram-order.service';

@Module({
  imports: [EncryptionModule, OrdersModule],
  controllers: [TelegramInternalController],
  providers: [BotApiKeyGuard, TelegramLinkingService, TelegramOrderService],
  exports: [TelegramLinkingService, TelegramOrderService],
})
export class TelegramModule {}
