import { describe, expect, it, jest } from '@jest/globals';

import type { ApplicationConfigService } from '../config/application-config.service';
import { TelegramDeliveryClient } from './telegram-delivery.client';

const configuration = {
  telegram: {
    botInternalUrl: 'http://telegram-bot:3001/',
    internalApiKey: 'shared-internal-key',
    deliveryTimeoutMs: 1000,
  },
} as ApplicationConfigService;

const message = {
  chatId: '2001',
  text: 'New Order\n#101',
  buttons: [
    {
      text: 'View Order',
      callbackData: 'd.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBB',
    },
  ],
};

describe('backend to bot prepared-message client', () => {
  it('authenticates the private request and accepts a confirmed message ID', async () => {
    const request = jest.fn(
      async () =>
        new Response(
          JSON.stringify({ outcome: 'delivered', messageId: '501' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    const client = new TelegramDeliveryClient(configuration, request);

    await expect(client.send(message)).resolves.toEqual({
      outcome: 'delivered',
      messageId: '501',
    });
    expect(request).toHaveBeenCalledWith(
      'http://telegram-bot:3001/internal/send-message',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-bot-api-key': 'shared-internal-key',
        }),
        body: JSON.stringify(message),
      })
    );
  });

  it('treats bot authentication rejection as terminal', async () => {
    const client = new TelegramDeliveryClient(
      configuration,
      jest.fn(async () => new Response('{}', { status: 401 }))
    );

    await expect(client.send(message)).resolves.toEqual({
      outcome: 'terminal_failure',
      category: 'authentication',
      code: 'bot-authentication-failed',
    });
  });

  it('treats transport and malformed-response outcomes as ambiguous', async () => {
    const unavailable = new TelegramDeliveryClient(
      configuration,
      jest.fn(async () => {
        throw new Error('sensitive connection detail');
      })
    );
    const malformed = new TelegramDeliveryClient(
      configuration,
      jest.fn(async () => new Response('{"token":"secret"}', { status: 200 }))
    );

    await expect(unavailable.send(message)).resolves.toEqual({
      outcome: 'ambiguous',
      category: 'transport',
      code: 'bot-outcome-unknown',
    });
    await expect(malformed.send(message)).resolves.toEqual({
      outcome: 'ambiguous',
      category: 'transport',
      code: 'bot-outcome-unknown',
    });
  });
});
