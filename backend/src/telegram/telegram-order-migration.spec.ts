import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('M11 callback reference migration', () => {
  it('adds expiring context-bound callback reference storage', () => {
    const schema = readFileSync(
      resolve(__dirname, '../../prisma/schema.prisma'),
      'utf8'
    );
    const migration = readFileSync(
      resolve(
        __dirname,
        '../../prisma/migrations/20260723230000_telegram_order_callback_references/migration.sql'
      ),
      'utf8'
    );

    expect(schema).toContain('model TelegramCallbackReference {');
    expect(schema).toContain('boundaryWcCreatedAt');
    expect(schema).toContain('targetWcOrderId');
    expect(migration).toContain('CREATE TABLE "telegram_callback_references"');
    expect(migration).toContain('"telegram_account_id" VARCHAR(64) NOT NULL');
    expect(migration).toContain('"tenant_id" VARCHAR(64) NOT NULL');
    expect(migration).toContain('"store_id" VARCHAR(64) NOT NULL');
    expect(migration).toContain('"expires_at" TIMESTAMPTZ(3) NOT NULL');
  });
});
