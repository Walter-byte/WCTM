-- M19 keeps WooCommerce authoritative and adds only the Store-scoped inventory
-- projection, resumable bootstrap progress, read references, and durable alert
-- delivery state required by the inventory MVP.

CREATE TYPE "inventory_sync_state" AS ENUM (
  'UNINITIALIZED',
  'SYNCING',
  'READY',
  'FAILED'
);

CREATE TYPE "inventory_item_kind" AS ENUM ('PRODUCT', 'VARIATION');

CREATE TYPE "inventory_alert_classification" AS ENUM (
  'OUT_OF_STOCK',
  'LOW_STOCK',
  'HEALTHY'
);

CREATE TYPE "inventory_alert_level" AS ENUM ('LOW_STOCK', 'OUT_OF_STOCK');

CREATE TYPE "telegram_inventory_reference_purpose" AS ENUM (
  'LIST_PAGE',
  'ITEM_DETAIL'
);

CREATE TYPE "telegram_inventory_notification_state" AS ENUM (
  'PENDING',
  'IN_FLIGHT',
  'DELIVERED',
  'RETRYABLE_FAILURE',
  'TERMINAL_FAILURE',
  'AMBIGUOUS'
);

ALTER TABLE "stores"
  ADD COLUMN "inventory_notification_policy_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "inventory_sync_state" "inventory_sync_state" NOT NULL DEFAULT 'UNINITIALIZED',
  ADD COLUMN "inventory_bootstrap_started_at" TIMESTAMPTZ(3),
  ADD COLUMN "inventory_bootstrap_completed_at" TIMESTAMPTZ(3),
  ADD COLUMN "inventory_bootstrap_failed_at" TIMESTAMPTZ(3),
  ADD COLUMN "inventory_bootstrap_failure_code" VARCHAR(191),
  ADD COLUMN "inventory_bootstrap_product_page" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "inventory_bootstrap_variation_page" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "inventory_bootstrap_parent_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "inventory_bootstrap_products_done" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "inventory_bootstrap_revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "inventory_bootstrap_lease_at" TIMESTAMPTZ(3),
  ADD CONSTRAINT "stores_inventory_bootstrap_progress_check" CHECK (
    "inventory_notification_policy_version" >= 0
    AND "inventory_bootstrap_product_page" >= 1
    AND "inventory_bootstrap_variation_page" >= 1
    AND "inventory_bootstrap_revision" >= 0
  );

ALTER TABLE "webhook_events"
  ADD CONSTRAINT "webhook_events_id_tenant_id_store_id_key"
  UNIQUE ("id", "tenant_id", "store_id");

ALTER TABLE "telegram_chat_authorizations"
  ADD CONSTRAINT "telegram_chat_authorizations_id_telegram_account_id_key"
  UNIQUE ("id", "telegram_account_id");

CREATE TABLE "inventory_items" (
  "id" VARCHAR(64) NOT NULL,
  "tenant_id" VARCHAR(64) NOT NULL,
  "store_id" VARCHAR(64) NOT NULL,
  "wc_item_id" VARCHAR(32) NOT NULL,
  "parent_wc_product_id" VARCHAR(32),
  "kind" "inventory_item_kind" NOT NULL,
  "display_name" VARCHAR(255) NOT NULL,
  "sku" VARCHAR(191),
  "variation_context" JSONB NOT NULL,
  "manages_stock" BOOLEAN NOT NULL,
  "stock_quantity" DECIMAL(20,6),
  "stock_status" VARCHAR(32) NOT NULL,
  "wc_modified_at" TIMESTAMPTZ(3) NOT NULL,
  "projection_fingerprint" VARCHAR(64) NOT NULL,
  "last_synced_at" TIMESTAMPTZ(3) NOT NULL,
  "last_webhook_received_at" TIMESTAMPTZ(3),
  "remote_deleted_at" TIMESTAMPTZ(3),
  "alert_classification" "inventory_alert_classification" NOT NULL DEFAULT 'HEALTHY',
  "incident_generation" INTEGER NOT NULL DEFAULT 0,
  "low_alert_source_webhook_event_id" VARCHAR(64),
  "low_alert_recipients_captured_at" TIMESTAMPTZ(3),
  "out_alert_source_webhook_event_id" VARCHAR(64),
  "out_alert_recipients_captured_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inventory_items_identity_check" CHECK (
    "wc_item_id" ~ '^[1-9][0-9]{0,31}$'
    AND (
      ("kind" = 'PRODUCT' AND "parent_wc_product_id" IS NULL)
      OR (
        "kind" = 'VARIATION'
        AND "parent_wc_product_id" ~ '^[1-9][0-9]{0,31}$'
      )
    )
  ),
  CONSTRAINT "inventory_items_stock_state_check" CHECK (
    "stock_status" IN ('instock', 'outofstock', 'onbackorder')
    AND (
      ("manages_stock" AND "stock_quantity" IS NOT NULL)
      OR (NOT "manages_stock" AND "stock_quantity" IS NULL)
    )
  ),
  CONSTRAINT "inventory_items_incident_check" CHECK (
    "incident_generation" >= 0
    AND (
      "low_alert_recipients_captured_at" IS NULL
      OR "low_alert_source_webhook_event_id" IS NOT NULL
    )
    AND (
      "out_alert_recipients_captured_at" IS NULL
      OR "out_alert_source_webhook_event_id" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX "inventory_items_store_id_wc_item_id_key"
  ON "inventory_items"("store_id", "wc_item_id");
CREATE UNIQUE INDEX "inventory_items_id_tenant_id_store_id_key"
  ON "inventory_items"("id", "tenant_id", "store_id");
CREATE INDEX "inventory_items_tenant_id_store_id_idx"
  ON "inventory_items"("tenant_id", "store_id");
CREATE INDEX "inventory_items_store_id_alert_classification_remote_delete_idx"
  ON "inventory_items"("store_id", "alert_classification", "remote_deleted_at");

CREATE TABLE "telegram_inventory_references" (
  "id" VARCHAR(64) NOT NULL,
  "telegram_account_id" VARCHAR(64) NOT NULL,
  "telegram_chat_id" BIGINT NOT NULL,
  "tenant_id" VARCHAR(64) NOT NULL,
  "store_id" VARCHAR(64) NOT NULL,
  "purpose" "telegram_inventory_reference_purpose" NOT NULL,
  "page_offset" INTEGER,
  "inventory_item_id" VARCHAR(64),
  "back_reference_id" VARCHAR(64),
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "telegram_inventory_references_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "telegram_inventory_references_shape_check" CHECK (
    (
      "purpose" = 'LIST_PAGE'
      AND "page_offset" BETWEEN 0 AND 192
      AND MOD("page_offset", 8) = 0
      AND "inventory_item_id" IS NULL
    )
    OR (
      "purpose" = 'ITEM_DETAIL'
      AND "page_offset" IS NULL
      AND "inventory_item_id" IS NOT NULL
      AND "back_reference_id" IS NOT NULL
    )
  )
);

CREATE INDEX "telegram_inventory_references_telegram_account_id_idx"
  ON "telegram_inventory_references"("telegram_account_id");
CREATE INDEX "telegram_inventory_references_telegram_chat_id_idx"
  ON "telegram_inventory_references"("telegram_chat_id");
CREATE INDEX "telegram_inventory_references_tenant_id_store_id_idx"
  ON "telegram_inventory_references"("tenant_id", "store_id");
CREATE INDEX "telegram_inventory_references_expires_at_idx"
  ON "telegram_inventory_references"("expires_at");

CREATE TABLE "telegram_inventory_notification_deliveries" (
  "id" VARCHAR(64) NOT NULL,
  "tenant_id" VARCHAR(64) NOT NULL,
  "store_id" VARCHAR(64) NOT NULL,
  "inventory_item_id" VARCHAR(64) NOT NULL,
  "incident_generation" INTEGER NOT NULL,
  "alert_level" "inventory_alert_level" NOT NULL,
  "policy_version" INTEGER NOT NULL,
  "telegram_account_id" VARCHAR(64) NOT NULL,
  "telegram_chat_authorization_id" VARCHAR(64) NOT NULL,
  "source_webhook_event_id" VARCHAR(64) NOT NULL,
  "state" "telegram_inventory_notification_state" NOT NULL DEFAULT 'PENDING',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at" TIMESTAMPTZ(3),
  "telegram_message_id" BIGINT,
  "failure_category" VARCHAR(32),
  "failure_code" VARCHAR(191),
  "delivered_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "telegram_inventory_notification_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "telegram_inventory_notification_deliveries_counts_check" CHECK (
    "incident_generation" > 0
    AND "policy_version" >= 0
    AND "attempt_count" >= 0
  )
);

CREATE UNIQUE INDEX "telegram_inventory_notification_deliveries_inventory_item_i_key"
  ON "telegram_inventory_notification_deliveries"(
    "inventory_item_id",
    "incident_generation",
    "alert_level",
    "telegram_chat_authorization_id"
  );
CREATE INDEX "telegram_inventory_notification_deliveries_tenant_id_store__idx"
  ON "telegram_inventory_notification_deliveries"("tenant_id", "store_id");
CREATE INDEX "telegram_inventory_notification_deliveries_store_id_invento_idx"
  ON "telegram_inventory_notification_deliveries"("store_id", "inventory_item_id");
CREATE INDEX "telegram_inventory_notification_deliveries_telegram_account_idx"
  ON "telegram_inventory_notification_deliveries"("telegram_account_id");
CREATE INDEX "telegram_inventory_notification_deliveries_source_webhook_e_idx"
  ON "telegram_inventory_notification_deliveries"("source_webhook_event_id");
CREATE INDEX "telegram_inventory_notification_deliveries_state_idx"
  ON "telegram_inventory_notification_deliveries"("state");

ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "inventory_items_store_id_tenant_id_fkey"
    FOREIGN KEY ("store_id", "tenant_id") REFERENCES "stores"("id", "tenant_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "telegram_inventory_references"
  ADD CONSTRAINT "telegram_inventory_references_telegram_account_id_fkey"
    FOREIGN KEY ("telegram_account_id") REFERENCES "telegram_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "telegram_inventory_references_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "telegram_inventory_references_store_id_tenant_id_fkey"
    FOREIGN KEY ("store_id", "tenant_id") REFERENCES "stores"("id", "tenant_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "telegram_inventory_references_inventory_item_id_tenant_id__fkey"
    FOREIGN KEY ("inventory_item_id", "tenant_id", "store_id")
    REFERENCES "inventory_items"("id", "tenant_id", "store_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "telegram_inventory_notification_deliveries"
  ADD CONSTRAINT "telegram_inventory_notification_deliveries_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "telegram_inventory_notification_deliveries_store_id_tenant_fkey"
    FOREIGN KEY ("store_id", "tenant_id") REFERENCES "stores"("id", "tenant_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "telegram_inventory_notification_deliveries_inventory_item__fkey"
    FOREIGN KEY ("inventory_item_id", "tenant_id", "store_id")
    REFERENCES "inventory_items"("id", "tenant_id", "store_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "telegram_inventory_notification_deliveries_telegram_accoun_fkey"
    FOREIGN KEY ("telegram_account_id") REFERENCES "telegram_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "telegram_inventory_notification_deliveries_telegram_chat_a_fkey"
    FOREIGN KEY ("telegram_chat_authorization_id", "telegram_account_id")
    REFERENCES "telegram_chat_authorizations"("id", "telegram_account_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "telegram_inventory_notification_deliveries_source_webhook__fkey"
    FOREIGN KEY ("source_webhook_event_id", "tenant_id", "store_id")
    REFERENCES "webhook_events"("id", "tenant_id", "store_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
