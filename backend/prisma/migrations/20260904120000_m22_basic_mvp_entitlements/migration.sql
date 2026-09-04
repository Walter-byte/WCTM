CREATE TYPE "tenant_entitlement_status" AS ENUM ('ACTIVE', 'SUSPENDED');

ALTER TABLE "tenants"
ADD COLUMN "entitlement_status" "tenant_entitlement_status" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "entitlement_expires_at" TIMESTAMPTZ(3);
