import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('M22 entitlement migration', () => {
  const schema = readFileSync(
    join(process.cwd(), 'prisma/schema.prisma'),
    'utf8'
  );
  const migration = readFileSync(
    join(
      process.cwd(),
      'prisma/migrations/20260904120000_m22_basic_mvp_entitlements/migration.sql'
    ),
    'utf8'
  );

  it('keeps the existing plan literals and adds only ACTIVE/SUSPENDED persistence', () => {
    expect(schema).toMatch(/enum TenantPlan \{\s+FREE\s+PRO\s+AGENCY/);
    expect(schema).toMatch(
      /enum TenantEntitlementStatus \{\s+ACTIVE\s+SUSPENDED/
    );
    expect(schema).not.toMatch(/\b(TRIAL|PAST_DUE|CANCELLED)\b/);
  });

  it('backfills existing Tenants and defaults new Tenants to ACTIVE with null expiry', () => {
    expect(migration).toContain(
      '"entitlement_status" "tenant_entitlement_status" NOT NULL DEFAULT \'ACTIVE\''
    );
    expect(migration).toContain('"entitlement_expires_at" TIMESTAMPTZ(3)');
    expect(migration).not.toMatch(/UPDATE|DELETE|notification|incident/i);
  });
});
