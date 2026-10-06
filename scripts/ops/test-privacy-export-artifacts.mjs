#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'wctm-privacy-export-test-'));
const directory = join(root, 'privacy');
const outside = join(root, 'outside');
const helper = 'scripts/ops/privacy-export-artifacts.sh';
const noNodeEnvironment = { ...process.env, PATH: '/usr/bin:/bin' };
assert.notEqual(
  spawnSync('/bin/bash', ['-c', 'command -v node'], {
    env: noNodeEnvironment,
  }).status,
  0
);
const run = (...args) =>
  execFileSync('/bin/bash', [helper, ...args], {
    encoding: 'utf8',
    env: noNodeEnvironment,
  }).trim();
const tenantA = 'ten_fixture_a';
const storeA = 'sto_fixture_a';
const tenantB = 'ten_fixture_b';
const storeB = 'sto_fixture_b';
const create = async (tenant, store, ageHours = 0) => {
  let path = run('new-path', directory, tenant, store);
  if (ageHours) {
    path = path.replace(
      /-[0-9]{13}-([0-9a-f]{16}\.json)$/,
      `-${Date.now() - ageHours * 3600000}-$1`
    );
  }
  await writeFile(path, 'fixture private data', { mode: 0o600 });
  return path;
};
const exists = async (path) =>
  readFile(path).then(
    () => true,
    () => false
  );

try {
  await mkdir(directory, { mode: 0o700 });
  await mkdir(outside, { mode: 0o700 });
  const ledger = join(directory, 'erasure-ledger.jsonl');
  const key = join(directory, 'backup.key');
  const unrelated = join(directory, 'operator-created.json');
  const lookalike = join(
    directory,
    'wctm-privacy-export-operator-created.json'
  );
  const backup = join(directory, 'wctm-postgres-fixture.dump');
  const outsideFile = join(outside, 'outside.json');
  for (const path of [ledger, key, unrelated, lookalike, backup, outsideFile]) {
    await writeFile(path, 'must survive', { mode: 0o600 });
  }
  const stale = await create(tenantA, storeA, 25);
  const fresh = await create(tenantA, storeA);
  const expectedScope = createHash('sha256')
    .update(`${tenantA}\0${storeA}`)
    .digest('hex');
  assert.ok(fresh.includes(`wctm-privacy-export-${expectedScope}-`));
  const otherScope = await create(tenantB, storeB, 25);
  const oldMtime = await create(tenantA, storeB);
  const yesterday = new Date(Date.now() - 25 * 3600000);
  await utimes(oldMtime, yesterday, yesterday);
  assert.match(run('sweep', directory), /removed=3$/);
  assert.equal(await exists(stale), false);
  assert.equal(await exists(otherScope), false);
  assert.equal(await exists(oldMtime), false);
  assert.equal(await exists(fresh), true);

  const delivered = await create(tenantA, storeA);
  const untouchedTenant = await create(tenantB, storeB);
  const sameStoreOtherTenant = await create(tenantB, storeA);
  const sameTenantOtherStore = await create(tenantA, storeB);
  assert.match(run('purge', directory, tenantA, storeA), /removed=2$/);
  assert.equal(await exists(fresh), false);
  assert.equal(await exists(delivered), false);
  assert.equal(await exists(untouchedTenant), true);
  assert.equal(await exists(sameStoreOtherTenant), true);
  assert.equal(await exists(sameTenantOtherStore), true);
  for (const path of [ledger, key, unrelated, lookalike, backup, outsideFile]) {
    assert.equal(await exists(path), true);
  }

  const symlinkName = run('new-path', directory, tenantA, storeA).replace(
    /-[0-9]{13}-([0-9a-f]{16}\.json)$/,
    `-${Date.now() - 25 * 3600000}-$1`
  );
  await symlink(outsideFile, symlinkName);
  const refused = spawnSync('/bin/bash', [helper, 'sweep', directory], {
    encoding: 'utf8',
    env: noNodeEnvironment,
  });
  assert.notEqual(refused.status, 0);
  assert.equal(await exists(outsideFile), true);
  const escape = spawnSync(
    '/bin/bash',
    [helper, 'sweep', `${directory}/../outside`],
    { encoding: 'utf8', env: noNodeEnvironment }
  );
  assert.notEqual(escape.status, 0);
  const wrongDirectory = spawnSync('/bin/bash', [helper, 'sweep', outside], {
    encoding: 'utf8',
    env: noNodeEnvironment,
  });
  assert.notEqual(wrongDirectory.status, 0);
  const linkedDirectory = join(root, 'linked-privacy');
  await symlink(directory, linkedDirectory);
  const linked = spawnSync('/bin/bash', [helper, 'sweep', linkedDirectory], {
    encoding: 'utf8',
    env: noNodeEnvironment,
  });
  assert.notEqual(linked.status, 0);
  assert.equal(await exists(outsideFile), true);
  assert.doesNotMatch(
    `${refused.stderr}${escape.stderr}${wrongDirectory.stderr}${linked.stderr}`,
    /fixture private data|must survive/
  );
  process.stdout.write(
    'privacy export retention: PASS expired/fresh exact scope protected files symlink traversal secret-safe\n'
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
