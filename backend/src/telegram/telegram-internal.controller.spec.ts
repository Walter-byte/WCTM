import { describe, expect, it, jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';

import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { IS_TENANT_OPTIONAL_KEY } from '../tenant/decorators/tenant-optional.decorator';
import { TelegramInternalController } from './telegram-internal.controller';
import type { TelegramLinkingService } from './telegram-linking.service';
import type { TelegramOrderService } from './telegram-order.service';

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
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, prototype.orderDetail)).toBe(
      true
    );
  });

  it('rejects a body/header update identity mismatch before service access', () => {
    const status = jest.fn();
    const controller = new TelegramInternalController(
      {
        status,
      } as unknown as TelegramLinkingService,
      {} as TelegramOrderService
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

  it('requires a valid Telegram update header before order service access', () => {
    const list = jest.fn();
    const controller = new TelegramInternalController(
      {} as TelegramLinkingService,
      { list } as unknown as TelegramOrderService
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
});
