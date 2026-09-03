import { describe, expect, it, jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';

import type { ApplicationConfigService } from '../config/application-config.service';
import { BotApiKeyGuard } from './guards/bot-api-key.guard';
import { TelegramInternalController } from './telegram-internal.controller';
import type { TelegramLinkingService } from './telegram-linking.service';
import type { TelegramOrderService } from './telegram-order.service';

function executionContext(apiKey: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { 'x-bot-api-key': apiKey },
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('M11 internal Telegram order authorization integration', () => {
  const configuration = {
    telegram: { internalApiKey: 'test-internal-api-key' },
  } as ApplicationConfigService;

  it('requires the bot key before invoking the list contract', async () => {
    const guard = new BotApiKeyGuard(configuration);
    const list = jest.fn(async () => ({
      state: 'OK' as const,
      orders: [],
      nextCursor: null,
      previousCursor: null,
      freshness: {
        asOf: '1970-01-01T00:00:00.000Z',
        delayed: true,
      },
    }));
    const controller = new TelegramInternalController(
      {} as TelegramLinkingService,
      { list } as unknown as TelegramOrderService,
      {} as never,
      {} as never,
      {} as never
    );

    expect(guard.canActivate(executionContext('test-internal-api-key'))).toBe(
      true
    );
    await expect(
      controller.listOrders(
        { telegram: { userId: '1001', chatId: '1001' } },
        '5001'
      )
    ).resolves.toMatchObject({ state: 'OK' });
    expect(list).toHaveBeenCalledWith({
      telegram: { userId: '1001', chatId: '1001' },
    });
  });

  it('rejects an invalid bot key before any detail service access', () => {
    const detail = jest.fn();
    const guard = new BotApiKeyGuard(configuration);

    expect(() =>
      guard.canActivate(executionContext('wrong-internal-api-key'))
    ).toThrow(UnauthorizedException);
    expect(detail).not.toHaveBeenCalled();
  });
});
