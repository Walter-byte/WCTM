import { createHash } from 'node:crypto';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function authIdentifierFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
