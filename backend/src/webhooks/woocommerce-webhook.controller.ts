import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';

import { Public } from '../auth/decorators/public.decorator';
import { WooCommerceWebhookIngestionService } from './woocommerce-webhook-ingestion.service';

export type WebhookRequestHeaders = Record<
  string,
  string | string[] | undefined
>;

@Controller('webhooks/woocommerce')
export class WooCommerceWebhookController {
  constructor(private readonly ingestion: WooCommerceWebhookIngestionService) {}

  @Post(':endpointKey')
  @Public()
  @HttpCode(HttpStatus.OK)
  receive(
    @Param('endpointKey') endpointKey: string,
    @Headers() headers: WebhookRequestHeaders,
    @Body() rawBody: unknown
  ): Promise<{ received: true }> {
    return this.ingestion.receive(endpointKey, headers, rawBody);
  }
}
