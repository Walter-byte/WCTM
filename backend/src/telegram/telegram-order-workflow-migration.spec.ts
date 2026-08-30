import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('M17 order workflow migration', () => {
  const schema = readFileSync(
    resolve(__dirname, '../../prisma/schema.prisma'),
    'utf8'
  );
  const migration = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20260830120000_m17_order_workflow_completion/migration.sql'
    ),
    'utf8'
  );

  it('extends the existing Order projection only with narrow context snapshots', () => {
    expect(schema).toContain('paymentSnapshot');
    expect(schema).toContain('shippingLinesSnapshot');
    expect(migration).toContain('"payment_snapshot" JSONB NOT NULL');
    expect(migration).toContain('"shipping_lines_snapshot" JSONB NOT NULL');
    expect(schema).not.toContain('model Payment {');
    expect(schema).not.toContain('model Shipping {');
    expect(schema).not.toContain('model Customer {');
  });

  it('adds purpose-specific note confirmation and durable single-effect state', () => {
    expect(schema).toContain('NOTE_INPUT');
    expect(schema).toContain('NOTE_CONFIRM');
    expect(schema).toContain('model TelegramOrderNoteAction {');
    expect(schema).toContain('noteBodyEncrypted');
    expect(schema).toContain('noteContentFingerprint');
    expect(schema).toContain('noteClaimedAt');
    expect(migration).toContain('CREATE TABLE "telegram_order_note_actions"');
    expect(migration).toContain(
      '"telegram_order_note_actions_callback_reference_id_key"'
    );
    expect(migration).not.toContain('note_body"');
  });
});
