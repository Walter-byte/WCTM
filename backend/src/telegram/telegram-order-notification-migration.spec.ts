import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('M13 order notification migration', () => {
  it('adds the narrow per-Order/private-chat durable delivery boundary', () => {
    const schema = readFileSync(
      resolve(__dirname, '../../prisma/schema.prisma'),
      'utf8'
    );
    const migration = readFileSync(
      resolve(
        __dirname,
        '../../prisma/migrations/20260820090000_order_event_notifications/migration.sql'
      ),
      'utf8'
    );

    expect(schema).toContain('model TelegramOrderNotificationDelivery {');
    expect(schema).toContain(
      '@@unique([orderId, telegramChatAuthorizationId])'
    );
    expect(migration).toContain(
      'CREATE TYPE "telegram_order_notification_state" AS ENUM'
    );
    expect(migration).toContain("'PENDING'");
    expect(migration).toContain("'IN_FLIGHT'");
    expect(migration).toContain("'DELIVERED'");
    expect(migration).toContain("'RETRYABLE_FAILURE'");
    expect(migration).toContain("'TERMINAL_FAILURE'");
    expect(migration).toContain("'AMBIGUOUS'");
    expect(migration).toContain(
      'ON "telegram_order_notification_deliveries"("order_id", "telegram_chat_authorization_id")'
    );
  });
});
