import { describe, expect, it, jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';

import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { IS_TENANT_OPTIONAL_KEY } from '../tenant/decorators/tenant-optional.decorator';
import { telegramRedeemSchema } from './dto/telegram-internal.dto';
import { TelegramInternalController } from './telegram-internal.controller';
import type { TelegramLinkingService } from './telegram-linking.service';
import type { TelegramOrderService } from './telegram-order.service';
import type { TelegramSettingsService } from './telegram-settings.service';

describe('TelegramInternalController authentication boundaries', () => {
  const prototype = TelegramInternalController.prototype;

  it('keeps link-token issuance on JWT auth and marks only bot routes Public', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.issueToken)).not.toBe(
      true
    );
    expect(
      Reflect.getMetadata(IS_TENANT_OPTIONAL_KEY, prototype.issueToken)
    ).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.redeem)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.status)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.unlink)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.listOrders)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.lookupOrder)).toBe(
      true
    );
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.orderDetail)).toBe(
      true
    );
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.orderTransitions)).toBe(
      true
    );
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.refreshOrder)).toBe(
      true
    );
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.orderNoteOptions)).toBe(
      true
    );
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.startOrderNote)).toBe(
      true
    );
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.prepareOrderNote)).toBe(
      true
    );
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.cancelOrderNote)).toBe(
      true
    );
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.confirmOrderNote)).toBe(
      true
    );
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, prototype.updateOrderStatus)
    ).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.settingsSummary)).toBe(
      true
    );
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, prototype.applySettingsAction)
    ).toBe(true);
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, prototype.startSettingsInput)
    ).toBe(true);
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, prototype.applySettingsInput)
    ).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.listStock)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.stockDetail)).toBe(
      true
    );
  });

  it('rejects a body/header update identity mismatch before service access', () => {
    const status = jest.fn();
    const controller = new TelegramInternalController(
      {
        status,
      } as unknown as TelegramLinkingService,
      {} as TelegramOrderService,
      {} as TelegramSettingsService,
      {} as never
    );

    expect(() =>
      controller.status(
        {
          telegramUserId: '1001',
          telegramChatId: '1001',
          updateId: '5001',
        },
        '5002'
      )
    ).toThrow(UnauthorizedException);
    expect(status).not.toHaveBeenCalled();
  });

  it('accepts only the exact issued M10 token representation', () => {
    const valid = `tgl_${'A_b-'.repeat(10)}A_b`;
    expect(valid).toHaveLength(47);
    const validated = telegramRedeemSchema.validate({
      telegramUserId: '1001',
      telegramChatId: '1001',
      chatType: 'private',
      token: `  ${valid}  `,
      updateId: '5001',
    });
    expect(validated.error).toBeUndefined();
    expect(validated.value.token).toBe(valid);

    for (const token of [
      `/start ${valid}`,
      `%2Fstart%20${valid}`,
      `"${valid}"`,
      `link_${'a'.repeat(43)}`,
      'tgl_too-short',
    ]) {
      expect(
        telegramRedeemSchema.validate({
          telegramUserId: '1001',
          telegramChatId: '1001',
          chatType: 'private',
          token,
          updateId: '5001',
        }).error
      ).toBeDefined();
    }
  });

  it('requires a valid Telegram update header before order service access', () => {
    const list = jest.fn();
    const controller = new TelegramInternalController(
      {} as TelegramLinkingService,
      { list } as unknown as TelegramOrderService,
      {} as TelegramSettingsService,
      {} as never
    );

    expect(() =>
      controller.listOrders(
        {
          telegram: { userId: '1001', chatId: '1001' },
        },
        undefined
      )
    ).toThrow(UnauthorizedException);
    expect(list).not.toHaveBeenCalled();
  });

  it('requires a valid Telegram update header before settings service access', () => {
    const summary = jest.fn();
    const controller = new TelegramInternalController(
      {} as TelegramLinkingService,
      {} as TelegramOrderService,
      { summary } as unknown as TelegramSettingsService,
      {} as never
    );

    expect(() =>
      controller.settingsSummary(
        { telegram: { userId: '1001', chatId: '1001' } },
        'not-an-update-id'
      )
    ).toThrow(UnauthorizedException);
    expect(summary).not.toHaveBeenCalled();
  });
});
