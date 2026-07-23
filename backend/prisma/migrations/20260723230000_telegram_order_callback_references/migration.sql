-- CreateEnum
CREATE TYPE "telegram_callback_purpose" AS ENUM ('LIST_PAGE', 'ORDER_DETAIL');

-- CreateEnum
CREATE TYPE "telegram_callback_direction" AS ENUM ('CURRENT', 'NEXT', 'PREVIOUS');

-- CreateTable
CREATE TABLE "telegram_callback_references" (
    "id" VARCHAR(64) NOT NULL,
    "telegram_account_id" VARCHAR(64) NOT NULL,
    "telegram_chat_id" BIGINT NOT NULL,
    "tenant_id" VARCHAR(64) NOT NULL,
    "store_id" VARCHAR(64) NOT NULL,
    "purpose" "telegram_callback_purpose" NOT NULL,
    "direction" "telegram_callback_direction",
    "boundary_wc_created_at" TIMESTAMPTZ(3),
    "boundary_wc_order_id" VARCHAR(32),
    "target_wc_order_id" VARCHAR(32),
    "reachable_offset" INTEGER,
    "back_reference_id" VARCHAR(64),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "telegram_callback_references_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "telegram_callback_references_telegram_account_id_idx" ON "telegram_callback_references"("telegram_account_id");

-- CreateIndex
CREATE INDEX "telegram_callback_references_telegram_chat_id_idx" ON "telegram_callback_references"("telegram_chat_id");

-- CreateIndex
CREATE INDEX "telegram_callback_references_tenant_id_store_id_idx" ON "telegram_callback_references"("tenant_id", "store_id");

-- CreateIndex
CREATE INDEX "telegram_callback_references_expires_at_idx" ON "telegram_callback_references"("expires_at");

-- AddForeignKey
ALTER TABLE "telegram_callback_references" ADD CONSTRAINT "telegram_callback_references_telegram_account_id_fkey" FOREIGN KEY ("telegram_account_id") REFERENCES "telegram_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_callback_references" ADD CONSTRAINT "telegram_callback_references_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_callback_references" ADD CONSTRAINT "telegram_callback_references_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
