ALTER TYPE "telegram_callback_purpose" ADD VALUE 'NOTE_INPUT';
ALTER TYPE "telegram_callback_purpose" ADD VALUE 'NOTE_CONFIRM';

CREATE TYPE "telegram_order_note_visibility" AS ENUM (
  'INTERNAL',
  'CUSTOMER'
);

CREATE TYPE "telegram_order_note_action_state" AS ENUM (
  'IN_FLIGHT',
  'SUCCEEDED',
  'FAILED',
  'AMBIGUOUS'
);

ALTER TABLE "orders"
ADD COLUMN "payment_snapshot" JSONB NOT NULL DEFAULT '{}'::JSONB,
ADD COLUMN "shipping_lines_snapshot" JSONB NOT NULL DEFAULT '[]'::JSONB;

ALTER TABLE "orders"
ALTER COLUMN "payment_snapshot" DROP DEFAULT,
ALTER COLUMN "shipping_lines_snapshot" DROP DEFAULT;

ALTER TABLE "telegram_callback_references"
ADD COLUMN "note_visibility" "telegram_order_note_visibility",
ADD COLUMN "note_body_encrypted" TEXT,
ADD COLUMN "note_content_fingerprint" VARCHAR(64),
ADD COLUMN "note_claimed_at" TIMESTAMPTZ(3);

CREATE TABLE "telegram_order_note_actions" (
  "id" VARCHAR(64) NOT NULL,
  "callback_reference_id" VARCHAR(64) NOT NULL,
  "telegram_account_id" VARCHAR(64) NOT NULL,
  "tenant_id" VARCHAR(64) NOT NULL,
  "store_id" VARCHAR(64) NOT NULL,
  "wc_order_id" VARCHAR(32) NOT NULL,
  "visibility" "telegram_order_note_visibility" NOT NULL,
  "content_fingerprint" VARCHAR(64) NOT NULL,
  "state" "telegram_order_note_action_state" NOT NULL DEFAULT 'IN_FLIGHT',
  "result" JSONB,
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "telegram_order_note_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_order_note_actions_callback_reference_id_key"
ON "telegram_order_note_actions"("callback_reference_id");

CREATE INDEX "telegram_order_note_actions_telegram_account_id_idx"
ON "telegram_order_note_actions"("telegram_account_id");

CREATE INDEX "telegram_order_note_actions_tenant_id_store_id_idx"
ON "telegram_order_note_actions"("tenant_id", "store_id");

CREATE INDEX "telegram_order_note_actions_store_id_wc_order_id_idx"
ON "telegram_order_note_actions"("store_id", "wc_order_id");

CREATE INDEX "telegram_order_note_actions_state_idx"
ON "telegram_order_note_actions"("state");

ALTER TABLE "telegram_order_note_actions"
ADD CONSTRAINT "telegram_order_note_actions_callback_reference_id_fkey"
FOREIGN KEY ("callback_reference_id") REFERENCES "telegram_callback_references"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "telegram_order_note_actions"
ADD CONSTRAINT "telegram_order_note_actions_telegram_account_id_fkey"
FOREIGN KEY ("telegram_account_id") REFERENCES "telegram_accounts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "telegram_order_note_actions"
ADD CONSTRAINT "telegram_order_note_actions_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "telegram_order_note_actions"
ADD CONSTRAINT "telegram_order_note_actions_store_id_fkey"
FOREIGN KEY ("store_id") REFERENCES "stores"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
