CREATE TYPE "telegram_order_notification_state" AS ENUM (
  'PENDING',
  'IN_FLIGHT',
  'DELIVERED',
  'RETRYABLE_FAILURE',
  'TERMINAL_FAILURE',
  'AMBIGUOUS'
);

CREATE TABLE "telegram_order_notification_deliveries" (
  "id" VARCHAR(64) NOT NULL,
  "tenant_id" VARCHAR(64) NOT NULL,
  "store_id" VARCHAR(64) NOT NULL,
  "order_id" VARCHAR(64) NOT NULL,
  "telegram_account_id" VARCHAR(64) NOT NULL,
  "telegram_chat_authorization_id" VARCHAR(64) NOT NULL,
  "source_webhook_event_id" VARCHAR(64) NOT NULL,
  "state" "telegram_order_notification_state" NOT NULL DEFAULT 'PENDING',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at" TIMESTAMPTZ(3),
  "telegram_message_id" BIGINT,
  "failure_category" VARCHAR(32),
  "failure_code" VARCHAR(191),
  "delivered_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "telegram_order_notification_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_order_notification_deliveries_order_id_telegram_ch_key"
  ON "telegram_order_notification_deliveries"("order_id", "telegram_chat_authorization_id");
CREATE INDEX "telegram_order_notification_deliveries_tenant_id_store_id_idx"
  ON "telegram_order_notification_deliveries"("tenant_id", "store_id");
CREATE INDEX "telegram_order_notification_deliveries_store_id_order_id_idx"
  ON "telegram_order_notification_deliveries"("store_id", "order_id");
CREATE INDEX "telegram_order_notification_deliveries_telegram_account_id_idx"
  ON "telegram_order_notification_deliveries"("telegram_account_id");
CREATE INDEX "telegram_order_notification_deliveries_source_webhook_event_idx"
  ON "telegram_order_notification_deliveries"("source_webhook_event_id");
CREATE INDEX "telegram_order_notification_deliveries_state_idx"
  ON "telegram_order_notification_deliveries"("state");

ALTER TABLE "telegram_order_notification_deliveries"
  ADD CONSTRAINT "telegram_order_notification_deliveries_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "telegram_order_notification_deliveries"
  ADD CONSTRAINT "telegram_order_notification_deliveries_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "telegram_order_notification_deliveries"
  ADD CONSTRAINT "telegram_order_notification_deliveries_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "telegram_order_notification_deliveries"
  ADD CONSTRAINT "telegram_order_notification_deliveries_telegram_account_id_fkey"
  FOREIGN KEY ("telegram_account_id") REFERENCES "telegram_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "telegram_order_notification_deliveries"
  ADD CONSTRAINT "telegram_order_notification_deliveries_telegram_chat_autho_fkey"
  FOREIGN KEY ("telegram_chat_authorization_id") REFERENCES "telegram_chat_authorizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "telegram_order_notification_deliveries"
  ADD CONSTRAINT "telegram_order_notification_deliveries_source_webhook_even_fkey"
  FOREIGN KEY ("source_webhook_event_id") REFERENCES "webhook_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
