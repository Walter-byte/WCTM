import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('M9 Order migration', () => {
  const schema = readFileSync(
    join(process.cwd(), 'prisma/schema.prisma'),
    'utf8'
  );
  const migration = readFileSync(
    join(
      process.cwd(),
      'prisma/migrations/20260723180000_order_projection/migration.sql'
    ),
    'utf8'
  );

  it('defines the Store-scoped Order model and uniqueness boundary', () => {
    expect(schema).toContain('model Order {');
    expect(schema).toContain('@@unique([storeId, wcOrderId])');
    expect(migration).toContain('CREATE TABLE "orders"');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "orders_store_id_wc_order_id_key" ON "orders"("store_id", "wc_order_id")'
    );
  });

  it('adds lease recovery and bounded failure diagnostics', () => {
    expect(migration).toContain(
      'RENAME COLUMN "processing_at" TO "processing_started_at"'
    );
    expect(migration).toContain(
      '"processing_attempt_count" INTEGER NOT NULL DEFAULT 0'
    );
    expect(migration).toContain('"failure_category" VARCHAR(32)');
    expect(migration).toContain('"failure_message" VARCHAR(191)');
  });
});
