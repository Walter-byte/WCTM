-- M20 adds only bounded projection-query indexes and privacy-protected,
-- short-lived backing state for mixed Order/Inventory search navigation.

CREATE TYPE "telegram_search_reference_purpose" AS ENUM ('PAGE', 'RESULT');
CREATE TYPE "telegram_search_result_kind" AS ENUM ('ORDER', 'INVENTORY');

CREATE TABLE "telegram_search_references" (
  "id" VARCHAR(64) NOT NULL,
  "telegram_account_id" VARCHAR(64) NOT NULL,
  "telegram_chat_id" BIGINT NOT NULL,
  "tenant_id" VARCHAR(64) NOT NULL,
  "membership_id" VARCHAR(64) NOT NULL,
  "store_id" VARCHAR(64) NOT NULL,
  "purpose" "telegram_search_reference_purpose" NOT NULL,
  "query_encrypted" TEXT,
  "page_offset" INTEGER,
  "result_kind" "telegram_search_result_kind",
  "target_wc_order_id" VARCHAR(32),
  "target_inventory_item_id" VARCHAR(64),
  "back_reference_id" VARCHAR(64),
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "telegram_search_references_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "telegram_search_references_shape_check" CHECK (
    (
      "purpose" = 'PAGE'
      AND "query_encrypted" IS NOT NULL
      AND "page_offset" BETWEEN 0 AND 192
      AND MOD("page_offset", 8) = 0
      AND "result_kind" IS NULL
      AND "target_wc_order_id" IS NULL
      AND "target_inventory_item_id" IS NULL
      AND "back_reference_id" IS NULL
    )
    OR (
      "purpose" = 'RESULT'
      AND "query_encrypted" IS NULL
      AND "page_offset" IS NULL
      AND "result_kind" IS NOT NULL
      AND "back_reference_id" IS NOT NULL
      AND (
        (
          "result_kind" = 'ORDER'
          AND "target_wc_order_id" IS NOT NULL
          AND "target_inventory_item_id" IS NULL
        )
        OR (
          "result_kind" = 'INVENTORY'
          AND "target_wc_order_id" IS NULL
          AND "target_inventory_item_id" IS NOT NULL
        )
      )
    )
  )
);

CREATE INDEX "telegram_search_references_telegram_account_id_idx"
  ON "telegram_search_references"("telegram_account_id");
CREATE INDEX "telegram_search_references_telegram_chat_id_idx"
  ON "telegram_search_references"("telegram_chat_id");
CREATE INDEX "telegram_search_references_tenant_id_store_id_idx"
  ON "telegram_search_references"("tenant_id", "store_id");
CREATE INDEX "telegram_search_references_membership_id_idx"
  ON "telegram_search_references"("membership_id");
CREATE INDEX "telegram_search_references_expires_at_idx"
  ON "telegram_search_references"("expires_at");

CREATE INDEX "orders_store_created_status_active_idx"
  ON "orders"("store_id", "wc_created_at", "status")
  WHERE "remote_deleted_at" IS NULL;

CREATE INDEX "orders_store_order_number_search_idx"
  ON "orders"("store_id", (lower("order_number")) text_pattern_ops)
  WHERE "remote_deleted_at" IS NULL;

CREATE INDEX "orders_store_customer_display_search_idx"
  ON "orders"(
    "store_id",
    (
      lower(
        COALESCE(
          NULLIF(
            btrim(
              COALESCE(
                NULLIF(btrim("customer_snapshot"->'billing'->>'first_name'), ''),
                ''
              )
              || ' '
              || COALESCE(
                NULLIF(btrim("customer_snapshot"->'billing'->>'last_name'), ''),
                ''
              )
            ),
            ''
          ),
          NULLIF(btrim("customer_snapshot"->'billing'->>'company'), ''),
          'Guest'
        )
      )
    ) text_pattern_ops
  )
  WHERE "remote_deleted_at" IS NULL;

CREATE INDEX "inventory_store_sku_search_idx"
  ON "inventory_items"("store_id", (lower("sku")) text_pattern_ops)
  WHERE "remote_deleted_at" IS NULL AND "sku" IS NOT NULL;

CREATE INDEX "inventory_store_display_name_search_idx"
  ON "inventory_items"("store_id", (lower("display_name")) text_pattern_ops)
  WHERE "remote_deleted_at" IS NULL;

ALTER TABLE "telegram_search_references"
  ADD CONSTRAINT "telegram_search_references_telegram_account_id_fkey"
    FOREIGN KEY ("telegram_account_id") REFERENCES "telegram_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "telegram_search_references_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "telegram_search_references_membership_id_tenant_id_fkey"
    FOREIGN KEY ("membership_id", "tenant_id") REFERENCES "memberships"("id", "tenant_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "telegram_search_references_store_id_tenant_id_fkey"
    FOREIGN KEY ("store_id", "tenant_id") REFERENCES "stores"("id", "tenant_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
