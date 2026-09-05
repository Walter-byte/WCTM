import type { INestApplication } from '@nestjs/common';
import { json, raw, urlencoded } from 'express';

export const JSON_BODY_LIMIT = '64kb';
export const WEBHOOK_BODY_LIMIT = '1mb';

export function configureBodyParsers(
  application: Pick<INestApplication, 'use'>
): void {
  application.use(
    '/api/webhooks/woocommerce/:endpointKey',
    raw({ type: 'application/json', inflate: false, limit: WEBHOOK_BODY_LIMIT })
  );
  application.use(json({ limit: JSON_BODY_LIMIT }));
  application.use(
    urlencoded({ extended: true, limit: JSON_BODY_LIMIT, parameterLimit: 100 })
  );
}
