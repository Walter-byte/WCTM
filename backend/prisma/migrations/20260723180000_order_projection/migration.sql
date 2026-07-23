-- AlterTable
ALTER TABLE "webhook_events"
RENAME COLUMN "processing_at" TO "processing_started_at";

ALTER TABLE "webhook_events"
ADD COLUMN "processing_attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failure_category" VARCHAR(32),
ADD COLUMN "failure_message" VARCHAR(191),
ADD COLUMN "last_failure_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "orders" (
    "id" VARCHAR(64) NOT NULL,
    "tenant_id" VARCHAR(64) NOT NULL,
    "store_id" VARCHAR(64) NOT NULL,
    "wc_order_id" VARCHAR(32) NOT NULL,
    "order_number" VARCHAR(191) NOT NULL,
    "status" VARCHAR(64) NOT NULL,
    "currency" VARCHAR(16) NOT NULL,
    "totals" JSONB NOT NULL,
    "customer_snapshot" JSONB NOT NULL,
    "line_items_snapshot" JSONB NOT NULL,
    "wc_created_at" TIMESTAMPTZ(3) NOT NULL,
    "wc_modified_at" TIMESTAMPTZ(3) NOT NULL,
    "projection_fingerprint" VARCHAR(64) NOT NULL,
    "remote_deleted_at" TIMESTAMPTZ(3),
    "last_synced_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "orders_tenant_id_idx" ON "orders"("tenant_id");

-- CreateIndex
CREATE INDEX "orders_store_id_idx" ON "orders"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_store_id_wc_order_id_key" ON "orders"("store_id", "wc_order_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
