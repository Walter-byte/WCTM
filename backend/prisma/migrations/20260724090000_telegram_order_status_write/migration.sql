ALTER TYPE "telegram_callback_purpose" ADD VALUE 'STATUS_WRITE';

ALTER TABLE "telegram_callback_references"
ADD COLUMN "allowed_target_statuses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "claimed_target_status" VARCHAR(64);

CREATE TABLE "telegram_order_status_writes" (
    "id" VARCHAR(64) NOT NULL,
    "callback_reference_id" VARCHAR(64) NOT NULL,
    "telegram_account_id" VARCHAR(64) NOT NULL,
    "tenant_id" VARCHAR(64) NOT NULL,
    "store_id" VARCHAR(64) NOT NULL,
    "wc_order_id" VARCHAR(32) NOT NULL,
    "target_status" VARCHAR(64) NOT NULL,
    "outcome" VARCHAR(32),
    "result" JSONB,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "telegram_order_status_writes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_order_status_writes_callback_reference_id_target_status_key"
ON "telegram_order_status_writes"("callback_reference_id", "target_status");

CREATE INDEX "telegram_order_status_writes_telegram_account_id_idx"
ON "telegram_order_status_writes"("telegram_account_id");

CREATE INDEX "telegram_order_status_writes_tenant_id_store_id_idx"
ON "telegram_order_status_writes"("tenant_id", "store_id");

CREATE INDEX "telegram_order_status_writes_store_id_wc_order_id_idx"
ON "telegram_order_status_writes"("store_id", "wc_order_id");

ALTER TABLE "telegram_order_status_writes"
ADD CONSTRAINT "telegram_order_status_writes_callback_reference_id_fkey"
FOREIGN KEY ("callback_reference_id") REFERENCES "telegram_callback_references"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "telegram_order_status_writes"
ADD CONSTRAINT "telegram_order_status_writes_telegram_account_id_fkey"
FOREIGN KEY ("telegram_account_id") REFERENCES "telegram_accounts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "telegram_order_status_writes"
ADD CONSTRAINT "telegram_order_status_writes_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "telegram_order_status_writes"
ADD CONSTRAINT "telegram_order_status_writes_store_id_fkey"
FOREIGN KEY ("store_id") REFERENCES "stores"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
