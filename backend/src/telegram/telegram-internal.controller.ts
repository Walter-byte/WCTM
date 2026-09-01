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
  type TelegramStockDetailResult,
  type TelegramStockListResult,
  TelegramInventoryService,
} from '../inventory/telegram-inventory.service';
import {
  type TelegramRedeemDto,
  type TelegramOrderDetailDto,
  type TelegramOrderListDto,
  type TelegramOrderLookupDto,
  type TelegramOrderNotePrepareDto,
  type TelegramOrderNoteStartDto,
  type TelegramOrderStatusUpdateDto,
  type TelegramOrderTransitionsDto,
  type TelegramStatusDto,
  type TelegramSettingsInputDto,
  type TelegramSettingsReferenceDto,
  type TelegramSettingsSummaryDto,
  type TelegramUnlinkDto,
  type TelegramStockDetailDto,
  type TelegramStockListDto,
  telegramOrderDetailSchema,
  telegramOrderListSchema,
  telegramOrderLookupSchema,
  telegramOrderNotePrepareSchema,
  telegramOrderNoteStartSchema,
  telegramOrderStatusUpdateSchema,
  telegramOrderTransitionsSchema,
  telegramRedeemSchema,
  telegramStatusSchema,
  telegramSettingsInputSchema,
  telegramSettingsReferenceSchema,
  telegramSettingsSummarySchema,
  telegramUnlinkSchema,
  telegramStockDetailSchema,
  telegramStockListSchema,
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
  type TelegramOrderLookupResult,
  type TelegramOrderNoteMutationResult,
  type TelegramOrderNoteOptionsResult,
  type TelegramOrderNotePrepareResult,
  type TelegramOrderNoteStartResult,
  type TelegramOrderRefreshResult,
  type TelegramOrderStatusUpdateResult,
  type TelegramOrderTransitionsResult,
  TelegramOrderService,
} from './telegram-order.service';
import {
  type TelegramSettingsInputStartResult,
  type TelegramSettingsResult,
  TelegramSettingsService,
} from './telegram-settings.service';

@Controller('internal/telegram')
export class TelegramInternalController {
  constructor(
    private readonly linking: TelegramLinkingService,
    private readonly orders: TelegramOrderService,
    private readonly settings: TelegramSettingsService,
    private readonly inventory: TelegramInventoryService
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

  @Post('orders/lookup')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  lookupOrder(
    @Body(new JoiValidationPipe(telegramOrderLookupSchema))
    input: TelegramOrderLookupDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramOrderLookupResult> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.orders.lookup(input);
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

  @Post('orders/refresh')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  refreshOrder(
    @Body(new JoiValidationPipe(telegramOrderDetailSchema))
    input: TelegramOrderDetailDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramOrderRefreshResult> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.orders.refresh(input);
  }

  @Post('orders/notes/options')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  orderNoteOptions(
    @Body(new JoiValidationPipe(telegramOrderDetailSchema))
    input: TelegramOrderDetailDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramOrderNoteOptionsResult> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.orders.noteOptions(input);
  }

  @Post('orders/notes/start')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  startOrderNote(
    @Body(new JoiValidationPipe(telegramOrderNoteStartSchema))
    input: TelegramOrderNoteStartDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramOrderNoteStartResult> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.orders.startNote(input);
  }

  @Post('orders/notes/prepare')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  prepareOrderNote(
    @Body(new JoiValidationPipe(telegramOrderNotePrepareSchema))
    input: TelegramOrderNotePrepareDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramOrderNotePrepareResult> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.orders.prepareNote(input);
  }

  @Post('orders/notes/cancel')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  cancelOrderNote(
    @Body(new JoiValidationPipe(telegramOrderDetailSchema))
    input: TelegramOrderDetailDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramOrderNoteMutationResult> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.orders.cancelNote(input);
  }

  @Post('orders/notes/confirm')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  confirmOrderNote(
    @Body(new JoiValidationPipe(telegramOrderDetailSchema))
    input: TelegramOrderDetailDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramOrderNoteMutationResult> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.orders.confirmNote(input);
  }

  @Post('orders/transitions')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  orderTransitions(
    @Body(new JoiValidationPipe(telegramOrderTransitionsSchema))
    input: TelegramOrderTransitionsDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramOrderTransitionsResult> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.orders.transitions(input);
  }

  @Post('orders/status')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  updateOrderStatus(
    @Body(new JoiValidationPipe(telegramOrderStatusUpdateSchema))
    input: TelegramOrderStatusUpdateDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramOrderStatusUpdateResult> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.orders.updateStatus(input);
  }

  @Post('settings/summary')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  settingsSummary(
    @Body(new JoiValidationPipe(telegramSettingsSummarySchema))
    input: TelegramSettingsSummaryDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramSettingsResult> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.settings.summary(input);
  }

  @Post('stock/list')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  listStock(
    @Body(new JoiValidationPipe(telegramStockListSchema))
    input: TelegramStockListDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramStockListResult> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.inventory.list(input);
  }

  @Post('stock/detail')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  stockDetail(
    @Body(new JoiValidationPipe(telegramStockDetailSchema))
    input: TelegramStockDetailDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramStockDetailResult> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.inventory.detail(input);
  }

  @Post('settings/action')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  applySettingsAction(
    @Body(new JoiValidationPipe(telegramSettingsReferenceSchema))
    input: TelegramSettingsReferenceDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramSettingsResult> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.settings.applyAction(input);
  }

  @Post('settings/input/start')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  startSettingsInput(
    @Body(new JoiValidationPipe(telegramSettingsReferenceSchema))
    input: TelegramSettingsReferenceDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramSettingsInputStartResult> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.settings.startInput(input);
  }

  @Post('settings/input/apply')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  applySettingsInput(
    @Body(new JoiValidationPipe(telegramSettingsInputSchema))
    input: TelegramSettingsInputDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramSettingsResult> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.settings.applyInput(input);
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
