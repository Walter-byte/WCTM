import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('M15 public account authentication migration', () => {
  const schema = readFileSync(
    join(process.cwd(), 'prisma/schema.prisma'),
    'utf8'
  );
  const migration = readFileSync(
    join(
      process.cwd(),
      'prisma/migrations/20260828120000_public_account_authentication/migration.sql'
    ),
    'utf8'
  );

  it('adds only the nullable mapped User password hash', () => {
    expect(schema).toContain(
      'passwordHash       String?             @map("password_hash") @db.Text'
    );
    expect(migration).toContain(
      'ALTER TABLE "users" ADD COLUMN "password_hash" TEXT;'
    );
    expect(migration).not.toContain('NOT NULL');
    expect(migration).not.toMatch(/CREATE TABLE/i);
  });

  it('refuses normalized historical email collisions without rewriting emails', () => {
    expect(migration).toContain('GROUP BY lower(btrim("email"))');
    expect(migration).toContain('HAVING count(*) > 1');
    expect(migration).toContain('RAISE EXCEPTION');
    expect(migration).not.toMatch(/UPDATE\s+"users"/i);
  });
});
