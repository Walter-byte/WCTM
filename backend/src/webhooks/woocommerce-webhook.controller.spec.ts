import { describe, expect, it, jest } from '@jest/globals';

import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { WooCommerceWebhookController } from './woocommerce-webhook.controller';
import type { WooCommerceWebhookIngestionService } from './woocommerce-webhook-ingestion.service';

describe('WooCommerceWebhookController', () => {
  it('flags webhook ingestion as explicitly public and forwards raw input only', async () => {
    const receive = jest.fn().mockResolvedValue({ received: true } as never);
    const controller = new WooCommerceWebhookController({
      receive,
    } as unknown as WooCommerceWebhookIngestionService);
    const rawBody = Buffer.from('{"id":1}');
    const headers = {
      'x-wc-webhook-signature': 'signature',
      'x-wc-webhook-id': '1',
      'x-wc-webhook-delivery-id': 'delivery-1',
      'x-wc-webhook-topic': 'order.created',
    };

    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        WooCommerceWebhookController.prototype.receive
      )
    ).toBe(true);
    await expect(
      controller.receive('whk_route', headers, rawBody)
    ).resolves.toEqual({ received: true });
    expect(receive).toHaveBeenCalledWith('whk_route', headers, rawBody);
  });
});
