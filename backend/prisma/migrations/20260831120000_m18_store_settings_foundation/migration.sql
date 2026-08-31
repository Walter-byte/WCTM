CREATE TYPE "tenant_language" AS ENUM ('fa', 'en');
CREATE TYPE "notification_category" AS ENUM ('ORDER_CREATED', 'LOW_STOCK');
CREATE TYPE "notification_recipient_mode" AS ENUM ('ALL_ELIGIBLE', 'SELECTED');
CREATE TYPE "telegram_settings_reference_purpose" AS ENUM (
  'ACTION',
  'TIMEZONE_INPUT',
  'THRESHOLD_INPUT'
);
CREATE TYPE "telegram_settings_action" AS ENUM (
  'SET_LANGUAGE',
  'SET_CATEGORY',
  'SET_RECIPIENT_MODE',
  'SET_RECIPIENT_SELECTION',
  'CLEAR_THRESHOLD'
);

ALTER TABLE "tenants"
ADD COLUMN "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
ADD COLUMN "language" "tenant_language";

UPDATE "tenants" SET "language" = 'en';

ALTER TABLE "tenants"
ALTER COLUMN "language" SET NOT NULL,
ALTER COLUMN "language" SET DEFAULT 'fa';

ALTER TABLE "stores"
ADD COLUMN "low_stock_threshold" INTEGER,
ADD COLUMN "enabled_notification_categories" "notification_category"[] NOT NULL DEFAULT ARRAY['ORDER_CREATED']::"notification_category"[],
ADD COLUMN "notification_recipient_mode" "notification_recipient_mode" NOT NULL DEFAULT 'ALL_ELIGIBLE';

ALTER TABLE "stores"
ADD CONSTRAINT "stores_low_stock_threshold_check"
CHECK ("low_stock_threshold" IS NULL OR ("low_stock_threshold" >= 0 AND "low_stock_threshold" <= 1000000));

ALTER TABLE "stores"
ADD CONSTRAINT "stores_enabled_notification_categories_check"
CHECK (
  cardinality("enabled_notification_categories") <= 2
  AND array_position("enabled_notification_categories", NULL) IS NULL
  AND cardinality("enabled_notification_categories") =
    (CASE WHEN 'ORDER_CREATED'::"notification_category" = ANY("enabled_notification_categories") THEN 1 ELSE 0 END) +
    (CASE WHEN 'LOW_STOCK'::"notification_category" = ANY("enabled_notification_categories") THEN 1 ELSE 0 END)
);

CREATE UNIQUE INDEX "stores_id_tenant_id_key" ON "stores"("id", "tenant_id");
CREATE UNIQUE INDEX "memberships_id_tenant_id_key" ON "memberships"("id", "tenant_id");

CREATE TABLE "store_notification_recipients" (
  "id" VARCHAR(64) NOT NULL,
  "tenant_id" VARCHAR(64) NOT NULL,
  "store_id" VARCHAR(64) NOT NULL,
  "membership_id" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "store_notification_recipients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "store_notification_recipients_store_membership_key"
ON "store_notification_recipients"("store_id", "membership_id");
CREATE INDEX "store_notification_recipients_tenant_store_idx"
ON "store_notification_recipients"("tenant_id", "store_id");
CREATE INDEX "store_notification_recipients_tenant_membership_idx"
ON "store_notification_recipients"("tenant_id", "membership_id");

ALTER TABLE "store_notification_recipients"
ADD CONSTRAINT "store_notification_recipients_store_tenant_fkey"
FOREIGN KEY ("store_id", "tenant_id") REFERENCES "stores"("id", "tenant_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "store_notification_recipients"
ADD CONSTRAINT "store_notification_recipients_membership_tenant_fkey"
FOREIGN KEY ("membership_id", "tenant_id") REFERENCES "memberships"("id", "tenant_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "telegram_settings_references" (
  "id" VARCHAR(64) NOT NULL,
  "telegram_account_id" VARCHAR(64) NOT NULL,
  "telegram_chat_id" BIGINT NOT NULL,
  "tenant_id" VARCHAR(64) NOT NULL,
  "store_id" VARCHAR(64) NOT NULL,
  "purpose" "telegram_settings_reference_purpose" NOT NULL,
  "action" "telegram_settings_action",
  "language" "tenant_language",
  "notification_category" "notification_category",
  "desired_enabled" BOOLEAN,
  "recipient_mode" "notification_recipient_mode",
  "target_membership_id" VARCHAR(64),
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "consumed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "telegram_settings_references_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "telegram_settings_references_telegram_account_idx"
ON "telegram_settings_references"("telegram_account_id");
CREATE INDEX "telegram_settings_references_telegram_chat_idx"
ON "telegram_settings_references"("telegram_chat_id");
CREATE INDEX "telegram_settings_references_tenant_store_idx"
ON "telegram_settings_references"("tenant_id", "store_id");
CREATE INDEX "telegram_settings_references_expires_at_idx"
ON "telegram_settings_references"("expires_at");

ALTER TABLE "telegram_settings_references"
ADD CONSTRAINT "telegram_settings_references_account_fkey"
FOREIGN KEY ("telegram_account_id") REFERENCES "telegram_accounts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "telegram_settings_references"
ADD CONSTRAINT "telegram_settings_references_tenant_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "telegram_settings_references"
ADD CONSTRAINT "telegram_settings_references_store_tenant_fkey"
FOREIGN KEY ("store_id", "tenant_id") REFERENCES "stores"("id", "tenant_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "telegram_settings_references"
ADD CONSTRAINT "telegram_settings_references_membership_tenant_fkey"
FOREIGN KEY ("target_membership_id", "tenant_id") REFERENCES "memberships"("id", "tenant_id")
ON DELETE RESTRICT ON UPDATE CASCADE;
