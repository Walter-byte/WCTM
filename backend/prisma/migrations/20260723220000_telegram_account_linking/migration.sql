-- CreateEnum
CREATE TYPE "telegram_chat_type" AS ENUM ('PRIVATE');

-- CreateTable
CREATE TABLE "telegram_accounts" (
    "id" VARCHAR(64) NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "user_id" VARCHAR(64) NOT NULL,
    "last_redeem_update_id" BIGINT,
    "last_unlink_update_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "telegram_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_chat_authorizations" (
    "id" VARCHAR(64) NOT NULL,
    "telegram_account_id" VARCHAR(64) NOT NULL,
    "telegram_chat_id" BIGINT NOT NULL,
    "chat_type" "telegram_chat_type" NOT NULL,
    "active_tenant_id" VARCHAR(64),
    "active_store_id" VARCHAR(64),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "telegram_chat_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_link_tokens" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" VARCHAR(64) NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "telegram_link_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_accounts_telegram_user_id_key" ON "telegram_accounts"("telegram_user_id");
CREATE UNIQUE INDEX "telegram_accounts_user_id_key" ON "telegram_accounts"("user_id");
CREATE INDEX "telegram_accounts_user_id_idx" ON "telegram_accounts"("user_id");
CREATE UNIQUE INDEX "telegram_chat_authorizations_telegram_chat_id_key" ON "telegram_chat_authorizations"("telegram_chat_id");
CREATE INDEX "telegram_chat_authorizations_telegram_account_id_idx" ON "telegram_chat_authorizations"("telegram_account_id");
CREATE INDEX "telegram_chat_authorizations_active_tenant_id_idx" ON "telegram_chat_authorizations"("active_tenant_id");
CREATE INDEX "telegram_chat_authorizations_active_store_id_idx" ON "telegram_chat_authorizations"("active_store_id");
CREATE UNIQUE INDEX "telegram_link_tokens_token_hash_key" ON "telegram_link_tokens"("token_hash");
CREATE INDEX "telegram_link_tokens_user_id_idx" ON "telegram_link_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "telegram_accounts" ADD CONSTRAINT "telegram_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "telegram_chat_authorizations" ADD CONSTRAINT "telegram_chat_authorizations_telegram_account_id_fkey" FOREIGN KEY ("telegram_account_id") REFERENCES "telegram_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "telegram_chat_authorizations" ADD CONSTRAINT "telegram_chat_authorizations_active_tenant_id_fkey" FOREIGN KEY ("active_tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "telegram_chat_authorizations" ADD CONSTRAINT "telegram_chat_authorizations_active_store_id_fkey" FOREIGN KEY ("active_store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "telegram_link_tokens" ADD CONSTRAINT "telegram_link_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
