-- CreateEnum
CREATE TYPE "webhook_event_status" AS ENUM ('RECEIVED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
UPDATE "stores"
SET "webhook_secret_encrypted" = NULL
WHERE "webhook_secret_encrypted" = '';

ALTER TABLE "stores"
ALTER COLUMN "webhook_secret_encrypted" DROP NOT NULL,
ADD COLUMN "webhook_endpoint_key" VARCHAR(64);

-- AlterTable
ALTER TABLE "webhook_events"
ADD COLUMN "webhook_id" VARCHAR(191),
ADD COLUMN "delivery_id" VARCHAR(191),
ADD COLUMN "status" "webhook_event_status" NOT NULL DEFAULT 'RECEIVED',
ADD COLUMN "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "queued_at" TIMESTAMPTZ(3),
ADD COLUMN "processing_at" TIMESTAMPTZ(3),
ADD COLUMN "completed_at" TIMESTAMPTZ(3),
ADD COLUMN "failed_at" TIMESTAMPTZ(3);

UPDATE "webhook_events"
SET "webhook_id" = 'legacy',
    "delivery_id" = "dedupe_key"
WHERE "webhook_id" IS NULL
   OR "delivery_id" IS NULL;

ALTER TABLE "webhook_events"
ALTER COLUMN "webhook_id" SET NOT NULL,
ALTER COLUMN "delivery_id" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "stores_webhook_endpoint_key_key" ON "stores"("webhook_endpoint_key");
