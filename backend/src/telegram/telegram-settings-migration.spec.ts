import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('M18 settings migration', () => {
  const schema = readFileSync(
    resolve(__dirname, '../../prisma/schema.prisma'),
    'utf8'
  );
  const migration = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20260831120000_m18_store_settings_foundation/migration.sql'
    ),
    'utf8'
  );

  it('backfills existing Tenants to English/UTC while defaulting future language to Persian', () => {
    expect(migration).toContain(
      'ADD COLUMN "timezone" VARCHAR(64) NOT NULL DEFAULT \'UTC\''
    );
    expect(migration).toContain('UPDATE "tenants" SET "language" = \'en\'');
    expect(migration).toContain('ALTER COLUMN "language" SET DEFAULT \'fa\'');
    expect(schema).toContain('timezone');
    expect(schema).toContain('@default("UTC")');
    expect(schema).toContain('language');
    expect(schema).toContain('@default(FA)');
  });

  it('preserves existing Store delivery defaults and nullable threshold', () => {
    expect(migration).toContain(
      'DEFAULT ARRAY[\'ORDER_CREATED\']::"notification_category"[]'
    );
    expect(migration).toContain("DEFAULT 'ALL_ELIGIBLE'");
    expect(migration).toContain('"low_stock_threshold" INTEGER');
    expect(migration).toContain('"low_stock_threshold" IS NULL');
    expect(schema).toContain('lowStockThreshold');
    expect(schema).toContain('Int?');
  });

  it('constrains category storage to a duplicate-free subset of the two enum values', () => {
    expect(migration).toContain(
      'CONSTRAINT "stores_enabled_notification_categories_check"'
    );
    expect(migration).toContain(
      'cardinality("enabled_notification_categories") <= 2'
    );
    expect(migration).toContain(
      'array_position("enabled_notification_categories", NULL) IS NULL'
    );
    expect(migration).toContain(
      '\'ORDER_CREATED\'::"notification_category" = ANY("enabled_notification_categories")'
    );
    expect(migration).toContain(
      '\'LOW_STOCK\'::"notification_category" = ANY("enabled_notification_categories")'
    );
  });

  it('enforces one Store/Membership preference and same-Tenant composite keys', () => {
    expect(schema).toContain('model StoreNotificationRecipient {');
    expect(schema).toContain('@@unique([storeId, membershipId])');
    expect(schema).toContain(
      '@relation(fields: [storeId, tenantId], references: [id, tenantId]'
    );
    expect(schema).toContain(
      '@relation(fields: [membershipId, tenantId], references: [id, tenantId]'
    );
    expect(migration).toContain(
      'FOREIGN KEY ("store_id", "tenant_id") REFERENCES "stores"("id", "tenant_id")'
    );
    expect(migration).toContain(
      'FOREIGN KEY ("membership_id", "tenant_id") REFERENCES "memberships"("id", "tenant_id")'
    );
    expect(migration).not.toContain('telegram_user_id');
    expect(migration).not.toContain('telegram_chat_authorization_id');
  });

  it('uses a narrow settings-only transient reference instead of bot state', () => {
    expect(schema).toContain('model TelegramSettingsReference {');
    expect(schema).toContain('TIMEZONE_INPUT');
    expect(schema).toContain('THRESHOLD_INPUT');
    expect(migration).toContain('CREATE TABLE "telegram_settings_references"');
    expect(migration).not.toContain('conversation_sessions');
  });
});
