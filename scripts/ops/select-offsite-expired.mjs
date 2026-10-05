#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const days = Number(process.argv[2]);
if (!Number.isInteger(days) || days < 1) {
  process.stderr.write('off-site retention: invalid age policy\n');
  process.exit(64);
}
const cutoff = new Date(Date.now() - days * 86400000)
  .toISOString()
  .replace(/[-:]/g, '')
  .slice(0, 15) + 'Z';
const names = new Set(readFileSync(0, 'utf8').split('\n').filter(Boolean));
const dumps = [...names].filter((name) =>
  /^wctm-postgres-\d{8}T\d{6}Z-[A-Za-z0-9]{1,40}\.dump\.enc$/.test(name)
).sort().reverse();
let kept = 0;
for (const name of dumps) {
  const sidecars = [`${name}.sha256`, `${name}.json`];
  if (!sidecars.every((sidecar) => names.has(sidecar))) continue;
  kept++;
  const timestamp = name.slice('wctm-postgres-'.length, 'wctm-postgres-'.length + 16);
  if (kept <= 2 || timestamp >= cutoff) continue;
  process.stdout.write(`${name}\n${sidecars.join('\n')}\n`);
}
