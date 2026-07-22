/*
  Warnings:

  - A unique constraint covering the columns `[registration_token_hash]` on the table `stores` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "last_healthy_at" TIMESTAMPTZ(3),
ADD COLUMN     "last_seen_at" TIMESTAMPTZ(3),
ADD COLUMN     "plugin_registered_at" TIMESTAMPTZ(3),
ADD COLUMN     "plugin_secret_hash" VARCHAR(64),
ADD COLUMN     "registration_token_consumed_at" TIMESTAMPTZ(3),
ADD COLUMN     "registration_token_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "registration_token_hash" VARCHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "stores_registration_token_hash_key" ON "stores"("registration_token_hash");
