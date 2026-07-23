import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('M10 Telegram linking migration', () => {
  const schema = readFileSync(
    join(process.cwd(), 'prisma/schema.prisma'),
    'utf8'
  );
  const migration = readFileSync(
    join(
      process.cwd(),
      'prisma/migrations/20260723220000_telegram_account_linking/migration.sql'
    ),
    'utf8'
  );

  it('defines one-to-one Telegram and SaaS account identities', () => {
    expect(schema).toContain('model TelegramAccount {');
    expect(schema).toContain('telegramUserId     BigInt');
    expect(schema).toContain('userId             String');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "telegram_accounts_telegram_user_id_key"'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "telegram_accounts_user_id_key"'
    );
  });

  it('keeps link tokens hashed and private chats constrained', () => {
    expect(schema).toContain('tokenHash  String');
    expect(migration).toContain(
      'CREATE TYPE "telegram_chat_type" AS ENUM (\'PRIVATE\')'
    );
    expect(migration).toContain('"chat_type" "telegram_chat_type" NOT NULL');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "telegram_chat_authorizations_telegram_chat_id_key"'
    );
    expect(migration).not.toContain('"token" ');
  });
});
