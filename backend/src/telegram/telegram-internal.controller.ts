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
  type TelegramSearchDto,
  type TelegramSearchSelectDto,
  type TelegramDailyReportDto,
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
  telegramSearchSchema,
  telegramSearchSelectSchema,
  telegramDailyReportSchema,
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
  type TelegramPresented,
  TelegramPresentationService,
} from './telegram-presentation.service';
import {
  type TelegramSettingsInputStartResult,
  type TelegramSettingsResult,
  TelegramSettingsService,
} from './telegram-settings.service';
import {
  type TelegramDailyReportResult,
  type TelegramSearchResult,
  type TelegramSearchSelectionResult,
  TelegramSearchReportService,
} from './telegram-search-report.service';

@Controller('internal/telegram')
export class TelegramInternalController {
  constructor(
    private readonly linking: TelegramLinkingService,
    private readonly orders: TelegramOrderService,
    private readonly settings: TelegramSettingsService,
    private readonly inventory: TelegramInventoryService,
    private readonly searchReport: TelegramSearchReportService,
    private readonly presentation?: TelegramPresentationService
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
  ): Promise<TelegramPresented<TelegramRedeemResult>> {
    this.assertUpdateId(input.updateId, headerUpdateId);
    return this.presentLinking(input, this.linking.redeem(input));
  }

  @Post('status')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  status(
    @Body(new JoiValidationPipe(telegramStatusSchema)) input: TelegramStatusDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramAuthorizationStatus>> {
    this.assertUpdateId(input.updateId, headerUpdateId);
    return this.presentLinking(input, this.linking.status(input));
  }

  @Post('unlink')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  unlink(
    @Body(new JoiValidationPipe(telegramUnlinkSchema)) input: TelegramUnlinkDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramUnlinkResult>> {
    this.assertUpdateId(input.updateId, headerUpdateId);
    return this.presentBeforeUnlink(input);
  }

  @Post('orders/list')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  listOrders(
    @Body(new JoiValidationPipe(telegramOrderListSchema))
    input: TelegramOrderListDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramOrderListResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.orders.list(input));
  }

  @Post('orders/lookup')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  lookupOrder(
    @Body(new JoiValidationPipe(telegramOrderLookupSchema))
    input: TelegramOrderLookupDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramOrderLookupResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.orders.lookup(input));
  }

  @Post('orders/detail')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  orderDetail(
    @Body(new JoiValidationPipe(telegramOrderDetailSchema))
    input: TelegramOrderDetailDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramOrderDetailResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.orders.detail(input));
  }

  @Post('orders/refresh')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  refreshOrder(
    @Body(new JoiValidationPipe(telegramOrderDetailSchema))
    input: TelegramOrderDetailDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramOrderRefreshResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.orders.refresh(input));
  }

  @Post('orders/notes/options')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  orderNoteOptions(
    @Body(new JoiValidationPipe(telegramOrderDetailSchema))
    input: TelegramOrderDetailDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramOrderNoteOptionsResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.orders.noteOptions(input));
  }

  @Post('orders/notes/start')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  startOrderNote(
    @Body(new JoiValidationPipe(telegramOrderNoteStartSchema))
    input: TelegramOrderNoteStartDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramOrderNoteStartResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.orders.startNote(input));
  }

  @Post('orders/notes/prepare')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  prepareOrderNote(
    @Body(new JoiValidationPipe(telegramOrderNotePrepareSchema))
    input: TelegramOrderNotePrepareDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramOrderNotePrepareResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.orders.prepareNote(input));
  }

  @Post('orders/notes/cancel')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  cancelOrderNote(
    @Body(new JoiValidationPipe(telegramOrderDetailSchema))
    input: TelegramOrderDetailDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramOrderNoteMutationResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.orders.cancelNote(input));
  }

  @Post('orders/notes/confirm')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  confirmOrderNote(
    @Body(new JoiValidationPipe(telegramOrderDetailSchema))
    input: TelegramOrderDetailDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramOrderNoteMutationResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.orders.confirmNote(input));
  }

  @Post('orders/transitions')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  orderTransitions(
    @Body(new JoiValidationPipe(telegramOrderTransitionsSchema))
    input: TelegramOrderTransitionsDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramOrderTransitionsResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.orders.transitions(input));
  }

  @Post('orders/status')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  updateOrderStatus(
    @Body(new JoiValidationPipe(telegramOrderStatusUpdateSchema))
    input: TelegramOrderStatusUpdateDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramOrderStatusUpdateResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.orders.updateStatus(input));
  }

  @Post('settings/summary')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  settingsSummary(
    @Body(new JoiValidationPipe(telegramSettingsSummarySchema))
    input: TelegramSettingsSummaryDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramSettingsResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.settings.summary(input));
  }

  @Post('stock/list')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  listStock(
    @Body(new JoiValidationPipe(telegramStockListSchema))
    input: TelegramStockListDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramStockListResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.inventory.list(input));
  }

  @Post('stock/detail')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  stockDetail(
    @Body(new JoiValidationPipe(telegramStockDetailSchema))
    input: TelegramStockDetailDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramStockDetailResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.inventory.detail(input));
  }

  @Post('search')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  search(
    @Body(new JoiValidationPipe(telegramSearchSchema)) input: TelegramSearchDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramSearchResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.searchReport.search(input));
  }

  @Post('search/select')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  selectSearchResult(
    @Body(new JoiValidationPipe(telegramSearchSelectSchema))
    input: TelegramSearchSelectDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramSearchSelectionResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.searchReport.select(input));
  }

  @Post('report')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  dailyReport(
    @Body(new JoiValidationPipe(telegramDailyReportSchema))
    input: TelegramDailyReportDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramDailyReportResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.searchReport.report(input));
  }

  @Post('settings/action')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  applySettingsAction(
    @Body(new JoiValidationPipe(telegramSettingsReferenceSchema))
    input: TelegramSettingsReferenceDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramSettingsResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.settings.applyAction(input));
  }

  @Post('settings/input/start')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  startSettingsInput(
    @Body(new JoiValidationPipe(telegramSettingsReferenceSchema))
    input: TelegramSettingsReferenceDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramSettingsInputStartResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.settings.startInput(input));
  }

  @Post('settings/input/apply')
  @Public()
  @UseGuards(BotApiKeyGuard)
  @HttpCode(HttpStatus.OK)
  applySettingsInput(
    @Body(new JoiValidationPipe(telegramSettingsInputSchema))
    input: TelegramSettingsInputDto,
    @Headers('x-telegram-update-id') headerUpdateId?: string
  ): Promise<TelegramPresented<TelegramSettingsResult>> {
    this.assertUpdateIdHeader(headerUpdateId);
    return this.present(input.telegram, this.settings.applyInput(input));
  }

  private async present<T>(
    identity: { userId: string; chatId: string },
    result: Promise<T>
  ): Promise<TelegramPresented<T>> {
    const resolved = await result;
    if (!this.presentation) {
      return resolved as TelegramPresented<T>;
    }
    return this.presentation.present(
      {
        telegramUserId: identity.userId,
        telegramChatId: identity.chatId,
      },
      resolved
    );
  }

  private async presentLinking<T>(
    identity: { telegramUserId: string; telegramChatId: string },
    result: Promise<T>
  ): Promise<TelegramPresented<T>> {
    const resolved = await result;
    return this.presentation
      ? this.presentation.present(identity, resolved)
      : (resolved as TelegramPresented<T>);
  }

  private async presentBeforeUnlink(
    input: TelegramUnlinkDto
  ): Promise<TelegramPresented<TelegramUnlinkResult>> {
    if (!this.presentation) {
      return (await this.linking.unlink(
        input
      )) as TelegramPresented<TelegramUnlinkResult>;
    }
    const presentation = await this.presentation.resolve(input);
    const result = await this.linking.unlink(input);
    return { ...result, presentation };
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
