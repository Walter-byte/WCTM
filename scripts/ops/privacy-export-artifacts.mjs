#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readdir, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const namePattern =
  /^wctm-privacy-export-([0-9a-f]{64})-([0-9]{13})-([0-9a-f]{16})\.json$/;
// An hourly timer removes files at 23 hours, leaving room before the 24-hour limit.
const sweepAgeMs = 23 * 60 * 60 * 1000;

function scopeHash(tenantId, storeId) {
  if (
    !/^ten_[A-Za-z0-9_-]+$/.test(tenantId) ||
    !/^sto_[A-Za-z0-9_-]+$/.test(storeId)
  ) {
    throw new Error('privacy export: exact Tenant and Store IDs are required');
  }
  return createHash('sha256').update(`${tenantId}\0${storeId}`).digest('hex');
}

async function protectedDirectory(path) {
  if (
    !path?.startsWith('/') ||
    resolve(path) === '/' ||
    path.split('/').includes('..')
  ) {
    throw new Error(
      'privacy export: an absolute protected directory is required'
    );
  }
  const details = await lstat(path);
  if (!details.isDirectory() || (details.mode & 0o777) !== 0o700) {
    throw new Error('privacy export: directory must be a 0700 real directory');
  }
  const directory = await realpath(path);
  const ledger = await lstat(join(directory, 'erasure-ledger.jsonl'));
  if (!ledger.isFile() || (ledger.mode & 0o777) !== 0o600) {
    throw new Error('privacy export: protected erasure ledger is required');
  }
  return directory;
}

async function removeEligible(directory, selectedScope) {
  let removed = 0;
  const now = Date.now();
  for (const name of await readdir(directory)) {
    const match = namePattern.exec(name);
    if (!match || (selectedScope && match[1] !== selectedScope)) continue;
    const createdAt = Number(match[2]);
    if (!Number.isSafeInteger(createdAt)) continue;
    const path = join(directory, name);
    const details = await lstat(path);
    if (!details.isFile() || (details.mode & 0o777) !== 0o600) {
      throw new Error(
        'privacy export: matching artifact is not a 0600 regular file'
      );
    }
    const earliestAgeEvidence = Math.min(
      createdAt,
      details.mtimeMs,
      details.birthtimeMs > 0 ? details.birthtimeMs : Infinity
    );
    if (!selectedScope && now - earliestAgeEvidence < sweepAgeMs) continue;
    await unlink(path);
    removed++;
  }
  return removed;
}

async function main() {
  const [mode, directoryArg, tenantId, storeId] = process.argv.slice(2);
  if (
    !['new-path', 'sweep', 'purge'].includes(mode) ||
    (mode === 'sweep' && process.argv.length !== 4) ||
    (mode !== 'sweep' && process.argv.length !== 6)
  ) {
    throw new Error(
      'usage: privacy-export-artifacts.mjs new-path|purge DIRECTORY TENANT_ID STORE_ID | sweep DIRECTORY'
    );
  }
  const directory = await protectedDirectory(directoryArg);
  if (mode === 'new-path') {
    const name = `wctm-privacy-export-${scopeHash(tenantId, storeId)}-${Date.now()}-${randomBytes(8).toString('hex')}.json`;
    process.stdout.write(`${join(directory, name)}\n`);
    return;
  }
  const removed = await removeEligible(
    directory,
    mode === 'purge' ? scopeHash(tenantId, storeId) : undefined
  );
  process.stdout.write(`privacy export cleanup: PASS removed=${removed}\n`);
}

main().catch(() => {
  process.stderr.write(
    'privacy export cleanup failed; inspect protected directory and operator configuration\n'
  );
  process.exitCode = 1;
});
