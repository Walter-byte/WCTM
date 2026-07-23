import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('M12 order status write migration', () => {
  it('extends callback references and adds durable write idempotency', () => {
    const schema = readFileSync(
      resolve(__dirname, '../../prisma/schema.prisma'),
      'utf8'
    );
    const migration = readFileSync(
      resolve(
        __dirname,
        '../../prisma/migrations/20260724090000_telegram_order_status_write/migration.sql'
      ),
      'utf8'
    );

    expect(schema).toContain('STATUS_WRITE');
    expect(schema).toContain('allowedTargetStatuses');
    expect(schema).toContain('claimedTargetStatus');
    expect(schema).toContain('model TelegramOrderStatusWrite {');
    expect(migration).toContain('CREATE TABLE "telegram_order_status_writes"');
    expect(migration).toContain(
      '"telegram_order_status_writes_callback_reference_id_target_status_key"'
    );
  });
});
