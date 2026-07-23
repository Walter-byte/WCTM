import { Module } from '@nestjs/common';

import { BotApiKeyGuard } from './guards/bot-api-key.guard';
import { TelegramInternalController } from './telegram-internal.controller';
import { TelegramLinkingService } from './telegram-linking.service';
import { TelegramOrderService } from './telegram-order.service';

@Module({
  controllers: [TelegramInternalController],
  providers: [BotApiKeyGuard, TelegramLinkingService, TelegramOrderService],
})
export class TelegramModule {}
