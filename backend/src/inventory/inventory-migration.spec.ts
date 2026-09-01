import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('M19 inventory migration', () => {
  const schema = readFileSync(
    resolve(__dirname, '../../prisma/schema.prisma'),
    'utf8'
  );
  const migration = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20260901120000_m19_inventory_low_stock/migration.sql'
    ),
    'utf8'
  );

  it('backfills every existing Store to explicit uninitialized inventory', () => {
    expect(migration).toContain(
      '"inventory_sync_state" "inventory_sync_state" NOT NULL DEFAULT \'UNINITIALIZED\''
    );
    expect(schema).toContain(
      'inventorySyncState                      InventorySyncState                      @default(UNINITIALIZED)'
    );
    expect(migration).not.toMatch(/INSERT INTO "inventory_items"/);
    expect(migration).not.toMatch(
      /telegram_inventory_notification_deliveries.*INSERT/is
    );
  });

  it('creates a narrow Store inventory projection, not a product catalog', () => {
    expect(schema).toContain('model InventoryItem {');
    expect(schema).toContain('@@unique([storeId, wcItemId])');
    expect(migration).toContain('CREATE TABLE "inventory_items"');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "inventory_items_store_id_wc_item_id_key"'
    );
    for (const forbidden of [
      'description',
      'regular_price',
      'sale_price',
      'image_url',
      'category_ids',
      'customer_id',
    ]) {
      expect(migration).not.toContain(forbidden);
    }
    expect(schema).not.toContain('model Product {');
  });

  it('enforces stock identity, incident state, and same-Tenant ownership', () => {
    expect(migration).toContain('CONSTRAINT "inventory_items_identity_check"');
    expect(migration).toContain(
      'CONSTRAINT "inventory_items_stock_state_check"'
    );
    expect(migration).toContain('CONSTRAINT "inventory_items_incident_check"');
    expect(migration).toContain(
      'FOREIGN KEY ("store_id", "tenant_id") REFERENCES "stores"("id", "tenant_id")'
    );
    expect(migration).toContain(
      'FOREIGN KEY ("inventory_item_id", "tenant_id", "store_id")'
    );
    expect(migration).toContain(
      'FOREIGN KEY ("source_webhook_event_id", "tenant_id", "store_id")'
    );
    expect(migration).toContain(
      'FOREIGN KEY ("telegram_chat_authorization_id", "telegram_account_id")'
    );
  });

  it('makes one incident-level-recipient delivery durably unique', () => {
    expect(schema).toContain(
      '@@unique([inventoryItemId, incidentGeneration, alertLevel, telegramChatAuthorizationId])'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "telegram_inventory_notification_deliveries_inventory_item_i_key"'
    );
    expect(migration).toContain("'AMBIGUOUS'");
    expect(migration).toContain("'RETRYABLE_FAILURE'");
    expect(schema).toContain('inventoryNotificationPolicyVersion');
    expect(schema).toContain('policyVersion');
    expect(migration).toContain('"policy_version" INTEGER NOT NULL');
  });

  it('stores only bounded bootstrap progress and signed-reference backing state', () => {
    expect(schema).toContain('inventoryBootstrapProductPage');
    expect(schema).toContain('inventoryBootstrapVariationPage');
    expect(schema).toContain('inventoryBootstrapParentIds');
    expect(schema).toContain('model TelegramInventoryReference {');
    expect(migration).toContain('page_offset" BETWEEN 0 AND 192');
    expect(migration).not.toMatch(/CREATE (?:TABLE|TYPE).*queue/i);
  });
});
