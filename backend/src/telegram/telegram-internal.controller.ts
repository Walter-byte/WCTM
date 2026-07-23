import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import type { JwtPayload } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { JoiValidationPipe } from '../common/validation/joi-validation.pipe';
import { TenantOptional } from '../tenant/decorators/tenant-optional.decorator';
import {
  type TelegramRedeemDto,
  type TelegramOrderDetailDto,
  type TelegramOrderListDto,
  type TelegramStatusDto,
  type TelegramUnlinkDto,
  telegramOrderDetailSchema,
  telegramOrderListSchema,
  telegramRedeemSchema,
  telegramStatusSchema,
  telegramUnlinkSchema,
  telegramUpdateIdSchema,
} from './dto/telegram-internal.dto';
import { BotApiKeyGuard } from './guards/bot-api-key.guard';
import {
  type TelegramAuthorizationStatus,
  type TelegramLinkTokenResult,
  type TelegramRedeemResult,
  type TelegramUnlinkResult,
  TelegramLinkingService,
} from './telegram-linking.service';
import {
  type TelegramOrderDetailResult,
  type TelegramOrderListResult,
  TelegramOrderService,
} from './telegram-order.service';

@Controller('internal/telegram')
export class TelegramInternalController {
  constructor(
    private readonly linking: TelegramLinkingService,
    private readonly orders: TelegramOrderService
  ) {}

  @Post('link-tokens')
  @TenantOptional()
  issueToken(
    @CurrentUser() user: JwtPayload | undefined
  ): Promise<TelegramLinkTokenResult> {
    return this.linking.issueToken(user);
  }

  @Post('redeem')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  redeem(
    @Body(new JoiValidationPipe(telegramRedeemSchema)) input: TelegramRedeemDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramRedeemResult> {
    this.assertUpdateId(input.updateId, headerUpdateId);
    return this.linking.redeem(input);
  }

  @Post('status')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  status(
    @Body(new JoiValidationPipe(telegramStatusSchema)) input: TelegramStatusDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramAuthorizationStatus> {
    this.assertUpdateId(input.updateId, headerUpdateId);
    return this.linking.status(input);
  }

  @Post('unlink')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  unlink(
    @Body(new JoiValidationPipe(telegramUnlinkSchema)) input: TelegramUnlinkDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramUnlinkResult> {
    this.assertUpdateId(input.updateId, headerUpdateId);
    return this.linking.unlink(input);
  }

  @Post('orders/list')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  listOrders(
    @Body(new JoiValidationPipe(telegramOrderListSchema))
    input: TelegramOrderListDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramOrderListResult> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.orders.list(input);
  }

  @Post('orders/detail')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  orderDetail(
    @Body(new JoiValidationPipe(telegramOrderDetailSchema))
    input: TelegramOrderDetailDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramOrderDetailResult> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.orders.detail(input);
  }

  private assertUpdateId(bodyUpdateId: string, headerUpdateId?: string): void {
    if (headerUpdateId !== bodyUpdateId) {
      throw new UnauthorizedException('Telegram update identity is invalid');
    }
  }

  private assertUpdateIdHeader(headerUpdateId?: string): void {
    if (telegramUpdateIdSchema.validate(headerUpdateId).error) {
      throw new UnauthorizedException('Telegram update identity is invalid');
    }
  }
}
