const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const {
  mkdtemp,
  writeFile,
  rm,
  mkdir,
  copyFile,
  chmod,
  readdir,
  readFile,
  stat,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { randomBytes } = require('node:crypto');

const { PrismaPg } = require('@prisma/adapter-pg');
const {
  PrismaClient,
  StoreStatus,
  TelegramChatType,
} = require('@prisma/client');
const {
  PilotAccountService,
  privacyFingerprint,
} = require('../../dist/privacy/pilot-account.service');
const { PilotDataService } = require('../../dist/privacy/pilot-data.service');
const {
  appendAccountLedger,
  appendLedger,
  replayLedger,
} = require('../../dist/privacy/pilot-data.cli');

const url = process.env.PPR2_ACCOUNT_TEST_DATABASE_URL;
if (
  !url ||
  !/^wctm_ppr2_account_test_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1))
)
  throw new Error('dedicated PPR-2 account test database is required');
const container = process.env.PPR2_ACCOUNT_TEST_CONTAINER;
if (!container || !/^wctm-account-test-[0-9]+$/.test(container))
  throw new Error('dedicated disposable account test container is required');
const database = new URL(url).pathname.slice(1);
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});

// Real Compose/CLI/database/crypto acceptance; only remote transport is a local fixture.
async function wrapperAcceptance(directory) {
  const privacy = join(directory, 'privacy');
  const remote = join(directory, 'remote');
  const bin = join(directory, 'bin');
  const recovered = join(directory, 'recovered');
  for (const path of [privacy, remote, bin, recovered])
    await mkdir(path, { mode: 0o700 });
  const ledger = join(privacy, 'erasure-ledger.jsonl');
  const credential = join(directory, 'database.conf');
  const key = join(directory, 'archive.key');
  const rcloneConfig = join(directory, 'rclone.conf');
  const compose = join(directory, 'compose.json');
  const image = execFileSync(
    'docker',
    ['image', 'inspect', '--format', '{{.Id}}', 'wctm-backend:latest'],
    { encoding: 'utf8' }
  ).trim();
  assert.equal(
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--pull=never',
        '--network=none',
        '--entrypoint',
        'node',
        image,
        '--version',
      ],
      { encoding: 'utf8' }
    ).trim(),
    'v24.20.0'
  );
  const dockerUrl = new URL(url);
  dockerUrl.hostname = 'host.docker.internal';
  await writeFile(ledger, '', { mode: 0o600 });
  await writeFile(credential, `DATABASE_URL=${dockerUrl.href}\n`, {
    mode: 0o600,
  });
  await writeFile(key, randomBytes(32), { mode: 0o600 });
  await writeFile(rcloneConfig, '[testremote]\ntype = local\n', {
    mode: 0o600,
  });
  await copyFile('scripts/ops/test-fixtures/rclone', join(bin, 'rclone-local'));
  await chmod(join(bin, 'rclone-local'), 0o700);
  await writeFile(
    join(bin, 'rclone'),
    `#!/bin/bash
if [[ \${PPR2_FAIL_ARCHIVE:-false} = true && \${1:-} = copyto ]]; then exit 1; fi
exec "$(dirname "$0")/rclone-local" "$@"
`,
    { mode: 0o700 }
  );
  await writeFile(
    compose,
    JSON.stringify({
      services: {
        backend: {
          image,
          pull_policy: 'never',
          working_dir: '/app/backend',
          user: `${process.getuid()}:${process.getgid()}`,
          environment: {
            APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
          },
          volumes: [`${resolve('backend/dist')}:/app/backend/dist:ro`],
        },
        'telegram-bot': {
          image: 'wctm-telegram-bot:latest',
          pull_policy: 'never',
        },
      },
    }),
    { mode: 0o600 }
  );
  const env = {
    ...process.env,
    COMPOSE_FILE: compose,
    COMPOSE_PROJECT_NAME: `wctm-account-wrapper-${process.pid}`,
    PATH: `${bin}:${process.env.PATH}`,
    WCTM_BACKUP_CRYPTO_KEY_FILE: key,
    RCLONE_CONFIG: rcloneConfig,
    WCTM_OFFSITE_DESTINATION: `testremote:${remote}`,
  };
  const run = (mode, args = [], overrides = {}) =>
    execFileSync(
      '/bin/bash',
      [
        'scripts/ops/pilot-privacy.sh',
        '--credential-file',
        credential,
        '--privacy-directory',
        privacy,
        '--',
        mode,
        ...args,
      ],
      {
        env: { ...env, ...overrides },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  try {
    const tenant = { id: 'ten_wrapper', name: 'Wrapper account' };
    await db.tenant.create({ data: tenant });
    await db.user.create({
      data: {
        id: 'usr_wrapper',
        email: 'wrapper@example.test',
        displayName: 'Wrapper identity',
        passwordHash: 'fixture-hash',
      },
    });
    await db.membership.create({
      data: { id: 'mem_wrapper', tenantId: tenant.id, userId: 'usr_wrapper' },
    });
    await db.store.create({
      data: {
        id: 'sto_wrapper',
        tenantId: tenant.id,
        name: 'Wrapper store',
        baseUrl: 'https://wrapper.example.test',
        status: StoreStatus.ACTIVE,
        consumerKeyEncrypted: 'fixture-encrypted',
        consumerSecretEncrypted: 'fixture-encrypted',
        pluginSecretHash: 'fixture-plugin-hash',
        webhookSecretEncrypted: 'fixture-secret',
        webhookEndpointKey: 'whk_fixture_old',
      },
    });
    const storeArgs = [
      '--tenant-id',
      tenant.id,
      '--store-id',
      'sto_wrapper',
      '--base-url',
      'https://wrapper.example.test',
    ];
    const identityArgs = [
      '--tenant-id',
      tenant.id,
      '--user-id',
      'usr_wrapper',
      '--email-sha256',
      privacyFingerprint('wrapper@example.test'),
    ];
    const tenantArgs = [
      '--tenant-id',
      tenant.id,
      '--name-sha256',
      privacyFingerprint(tenant.name),
    ];
    await db.store.create({
      data: {
        id: 'sto_wrapper_other',
        tenantId: 'ten_account_b',
        name: 'Unrelated store',
        baseUrl: 'https://wrapper.example.test',
        status: StoreStatus.ACTIVE,
        consumerKeyEncrypted: 'unrelated-encrypted-key',
        consumerSecretEncrypted: 'unrelated-encrypted-secret',
      },
    });
    const otherStore = await db.store.findUniqueOrThrow({
      where: { id: 'sto_wrapper_other' },
    });
    assert.throws(() =>
      run('export', [
        '--tenant-id',
        'ten_account_b',
        '--store-id',
        'sto_wrapper',
        '--base-url',
        'https://wrapper.example.test',
        '--retain-for-delivery',
      ])
    );
    const olderBackup = execFileSync('docker', [
      'exec',
      container,
      'pg_dump',
      '-U',
      'postgres',
      '-Fc',
      database,
    ]);
    const unaffected = await db.tenant.findUniqueOrThrow({
      where: { id: 'ten_account_b' },
    });
    const exported = run('identity-export', [
      ...identityArgs,
      '--retain-for-delivery',
    ]);
    const exportPath = exported.match(
      /privacy export retained for delivery: (.+)/
    )[1];
    assert.equal((await stat(exportPath)).mode & 0o777, 0o600);
    assert.equal(
      JSON.parse(await readFile(exportPath, 'utf8')).membership.user.email,
      'wrapper@example.test'
    );
    assert.throws(() =>
      run('identity-erase', [...identityArgs, '--execute'], {
        PPR2_FAIL_ARCHIVE: 'true',
      })
    );
    assert.equal(
      (await db.user.findUniqueOrThrow({ where: { id: 'usr_wrapper' } })).email,
      'wrapper@example.test'
    );
    assert.ok((await readFile(ledger, 'utf8')).includes('usr_wrapper'));
    await stat(exportPath); // Failed archive leaves delivery export available and no erasure occurred.
    assert.match(
      run('disconnect', [...storeArgs, '--execute']),
      /"disconnected":true/
    );
    const disconnected = await db.store.findUniqueOrThrow({
      where: { id: 'sto_wrapper' },
    });
    for (const field of [
      'pluginSecretHash',
      'registrationTokenHash',
      'webhookSecretEncrypted',
      'webhookEndpointKey',
    ])
      assert.equal(disconnected[field], null);
    assert.ok(disconnected.deletedAt);
    assert.match(
      run('erase', [...storeArgs, '--execute']),
      /erasure archive: PASS/
    );
    assert.match(
      run('identity-erase', [...identityArgs, '--execute']),
      /erasure archive: PASS/
    );
    await assert.rejects(stat(exportPath));
    assert.match(
      run('tenant-erase', [...tenantArgs, '--execute']),
      /erasure archive: PASS/
    );
    const archiveDirectory = join(remote, 'privacy-erasure-ledger');
    const files = (await readdir(archiveDirectory)).filter((name) =>
      name.endsWith('.jsonl.enc')
    );
    const ledgerSha = require('node:crypto')
      .createHash('sha256')
      .update(await readFile(ledger))
      .digest('hex')
      .slice(0, 12);
    const archive = join(
      archiveDirectory,
      files.find((name) => name.endsWith(`-${ledgerSha}.jsonl.enc`))
    );
    assert.ok(!(await readFile(archive)).includes(Buffer.from('usr_wrapper')));
    assert.match(
      execFileSync(
        '/bin/bash',
        ['scripts/ops/restore-erasure-ledger.sh', archive, recovered],
        { env, encoding: 'utf8' }
      ),
      /restore: PASS/
    );
    assert.equal(
      (await stat(join(recovered, 'erasure-ledger.jsonl'))).mode & 0o777,
      0o600
    );
    assert.deepEqual(
      await readFile(join(recovered, 'erasure-ledger.jsonl')),
      await readFile(ledger)
    );
    await db.$disconnect();
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        container,
        'pg_restore',
        '-U',
        'postgres',
        '--clean',
        '--if-exists',
        '-d',
        database,
      ],
      { input: olderBackup }
    );
    await db.$connect();
    assert.equal(
      (await db.user.findUniqueOrThrow({ where: { id: 'usr_wrapper' } })).email,
      'wrapper@example.test'
    );
    await copyFile(join(recovered, 'erasure-ledger.jsonl'), ledger);
    assert.match(run('replay', ['--execute']), /"pending":3/);
    assert.match(run('replay', ['--execute']), /"pending":0/);
    assert.equal(
      (await db.user.findUniqueOrThrow({ where: { id: 'usr_wrapper' } })).email,
      'erased-usr_wrapper@invalid.invalid'
    );
    assert.equal(
      (await db.store.findUniqueOrThrow({ where: { id: 'sto_wrapper' } }))
        .baseUrl,
      'https://erased.invalid/sto_wrapper'
    );
    assert.deepEqual(
      await db.tenant.findUniqueOrThrow({ where: { id: unaffected.id } }),
      unaffected
    );
    assert.deepEqual(
      await db.store.findUniqueOrThrow({ where: { id: otherStore.id } }),
      otherStore
    );
    assert.equal(
      execFileSync(
        'docker',
        [
          'compose',
          'ps',
          '--status',
          'running',
          '-q',
          'backend',
          'telegram-bot',
        ],
        { env, encoding: 'utf8' }
      ).trim(),
      ''
    );
    console.log(
      'pilot account wrapper: PASS Node24 real-compose-cli protected-export archive-copy-failure-no-erasure encrypted-local-archive authenticated-ledger-recovery older-backup-restore replay-while-apps-stopped repeat-isolation'
    );
  } finally {
    execFileSync('docker', ['compose', 'down', '--remove-orphans'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'wctm-account-ledger-'));
  try {
    const ledger = join(directory, 'erasure-ledger.jsonl');
    await writeFile(ledger, '', { mode: 0o600 });
    await db.tenant.createMany({
      data: [
        { id: 'ten_account_a', name: 'Account A', deletedAt: new Date() },
        { id: 'ten_account_b', name: 'Account B' },
      ],
    });
    await db.user.createMany({
      data: [
        {
          id: 'usr_exclusive',
          email: 'exclusive@example.test',
          displayName: 'Exclusive',
          passwordHash: 'fixture-hash',
        },
        {
          id: 'usr_removed',
          email: 'removed@example.test',
          displayName: 'Removed',
          passwordHash: 'fixture-hash',
        },
        {
          id: 'usr_direct',
          email: 'direct@example.test',
          displayName: 'Direct',
          passwordHash: 'fixture-hash',
        },
        {
          id: 'usr_shared',
          email: 'shared@example.test',
          displayName: 'Shared',
          passwordHash: 'fixture-hash',
        },
      ],
    });
    await db.membership.createMany({
      data: [
        {
          id: 'mem_exclusive',
          tenantId: 'ten_account_a',
          userId: 'usr_exclusive',
          deletedAt: new Date(),
        },
        {
          id: 'mem_removed',
          tenantId: 'ten_account_a',
          userId: 'usr_removed',
          deletedAt: new Date(),
        },
        {
          id: 'mem_direct',
          tenantId: 'ten_account_b',
          userId: 'usr_direct',
          deletedAt: new Date(),
        },
        {
          id: 'mem_shared_a',
          tenantId: 'ten_account_a',
          userId: 'usr_shared',
          deletedAt: new Date(),
        },
        {
          id: 'mem_shared_b',
          tenantId: 'ten_account_b',
          userId: 'usr_shared',
          deletedAt: new Date(),
        },
      ],
    });
    await db.store.create({
      data: {
        id: 'sto_account_a',
        tenantId: 'ten_account_a',
        name: 'Erased store',
        baseUrl: 'https://erased.invalid/sto_account_a',
        status: StoreStatus.DISCONNECTED,
        deletedAt: new Date(),
        consumerKeyEncrypted: 'fixture-revoked',
        consumerSecretEncrypted: 'fixture-revoked',
      },
    });
    await db.telegramAccount.createMany({
      data: [
        {
          id: 'tga_exclusive',
          userId: 'usr_exclusive',
          telegramUserId: 10001n,
          deletedAt: new Date(),
        },
        { id: 'tga_shared', userId: 'usr_shared', telegramUserId: 10002n },
      ],
    });
    await db.telegramChatAuthorization.createMany({
      data: [
        {
          id: 'chat_exclusive',
          telegramAccountId: 'tga_exclusive',
          telegramChatId: 10001n,
          chatType: TelegramChatType.PRIVATE,
          activeTenantId: 'ten_account_a',
          activeStoreId: 'sto_account_a',
        },
        {
          id: 'chat_shared',
          telegramAccountId: 'tga_shared',
          telegramChatId: 10002n,
          chatType: TelegramChatType.PRIVATE,
          activeTenantId: 'ten_account_a',
          activeStoreId: 'sto_account_a',
        },
        {
          id: 'chat_shared_b',
          telegramAccountId: 'tga_shared',
          telegramChatId: 10003n,
          chatType: TelegramChatType.PRIVATE,
          activeTenantId: 'ten_account_b',
        },
      ],
    });
    await db.auditLog.create({
      data: {
        id: 'aud_account_fixture',
        tenantId: 'ten_account_a',
        userId: 'usr_exclusive',
        action: 'fixture',
        entityType: 'User',
        entityId: 'usr_exclusive',
        metadata: {},
      },
    });

    const accounts = new PilotAccountService(db);
    await assert.rejects(
      accounts.eraseIdentity({
        tenantId: 'ten_account_b',
        userId: 'usr_exclusive',
        emailSha256: privacyFingerprint('exclusive@example.test'),
      }),
      /missing, erased or ambiguous/
    );
    const tenantTarget = {
      tenantId: 'ten_account_a',
      nameSha256: privacyFingerprint('Account A'),
    };
    const userTarget = {
      tenantId: 'ten_account_a',
      userId: 'usr_exclusive',
      emailSha256: privacyFingerprint('exclusive@example.test'),
    };
    const tenantExport = await accounts.exportTenant(tenantTarget);
    assert.deepEqual(
      tenantExport.stores.map((store) => store.id),
      ['sto_account_a']
    );
    assert.deepEqual(
      tenantExport.memberships.map((membership) => membership.user.id).sort(),
      ['usr_exclusive', 'usr_removed', 'usr_shared']
    );
    assert.deepEqual(
      tenantExport.audit.map((entry) => entry.id),
      ['aud_account_fixture']
    );
    const userExport = await accounts.exportIdentity(userTarget);
    assert.equal(userExport.membership.user.email, 'exclusive@example.test');
    assert.equal(userExport.audit.length, 1);
    await appendLedger(ledger, {
      tenantId: 'ten_account_a',
      storeId: 'sto_account_a',
      baseUrl: 'https://shop.example.test',
    });
    await appendAccountLedger(ledger, userTarget);
    await appendAccountLedger(ledger, tenantTarget);
    // The protected ledger survives a genuine restore of the earlier removed-
    // membership backup. Reactivation and approved erasure occur after backup.
    const backup = execFileSync('docker', [
      'exec',
      container,
      'pg_dump',
      '-U',
      'postgres',
      '-Fc',
      database,
    ]);
    await db.membership.update({
      where: { id: 'mem_exclusive' },
      data: { deletedAt: null },
    });
    await accounts.eraseIdentity(userTarget);
    assert.equal(
      (await db.user.findUniqueOrThrow({ where: { id: 'usr_exclusive' } }))
        .email,
      'erased-usr_exclusive@invalid.invalid'
    );
    await db.$disconnect();
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        container,
        'pg_restore',
        '-U',
        'postgres',
        '--clean',
        '--if-exists',
        '-d',
        database,
      ],
      { input: backup }
    );
    await db.$connect();
    assert.ok(
      (
        await db.membership.findUniqueOrThrow({
          where: { id: 'mem_exclusive' },
        })
      ).deletedAt
    );
    assert.equal(
      (await db.user.findUniqueOrThrow({ where: { id: 'usr_exclusive' } }))
        .email,
      'exclusive@example.test'
    );
    const stores = new PilotDataService(db, { encrypt: () => 'unused' });
    assert.equal(
      (await replayLedger(ledger, stores, db, false, accounts)).pending,
      2
    );
    assert.equal(
      (await replayLedger(ledger, stores, db, true, accounts)).pending,
      2
    );
    assert.equal(
      (await replayLedger(ledger, stores, db, true, accounts)).pending,
      0
    );

    const exclusive = await db.user.findUniqueOrThrow({
      where: { id: 'usr_exclusive' },
    });
    const shared = await db.user.findUniqueOrThrow({
      where: { id: 'usr_shared' },
    });
    assert.equal(exclusive.email, 'erased-usr_exclusive@invalid.invalid');
    assert.equal(exclusive.passwordHash, null);
    assert.equal(shared.email, 'shared@example.test');
    const removed = await db.user.findUniqueOrThrow({
      where: { id: 'usr_removed' },
    });
    assert.equal(removed.email, 'erased-usr_removed@invalid.invalid');
    assert.equal(removed.displayName, null);
    assert.equal(removed.passwordHash, null);
    const exclusiveTelegram = await db.telegramAccount.findUniqueOrThrow({
      where: { userId: 'usr_exclusive' },
    });
    const sharedTelegram = await db.telegramAccount.findUniqueOrThrow({
      where: { userId: 'usr_shared' },
    });
    assert.ok(exclusiveTelegram.telegramUserId < 0n);
    assert.ok(exclusiveTelegram.deletedAt);
    assert.equal(sharedTelegram.telegramUserId, 10002n);
    const chat = await db.telegramChatAuthorization.findUniqueOrThrow({
      where: { id: 'chat_exclusive' },
    });
    assert.ok(chat.telegramChatId < 0n);
    assert.equal(chat.activeTenantId, null);
    const otherTenantChat =
      await db.telegramChatAuthorization.findUniqueOrThrow({
        where: { id: 'chat_shared_b' },
      });
    assert.equal(otherTenantChat.activeTenantId, 'ten_account_b');
    assert.equal(otherTenantChat.telegramChatId, 10003n);
    const tenantA = await db.tenant.findUniqueOrThrow({
      where: { id: 'ten_account_a' },
    });
    const tenantB = await db.tenant.findUniqueOrThrow({
      where: { id: 'ten_account_b' },
    });
    assert.ok(tenantA.deletedAt);
    assert.equal(tenantB.deletedAt, null);
    const sharedMembership = await db.membership.findUniqueOrThrow({
      where: { id: 'mem_shared_b' },
    });
    assert.ok(sharedMembership.deletedAt);
    const directTarget = {
      tenantId: 'ten_account_b',
      userId: 'usr_direct',
      emailSha256: privacyFingerprint('direct@example.test'),
    };
    await accounts.eraseIdentity(directTarget);
    assert.equal(
      (await db.user.findUniqueOrThrow({ where: { id: 'usr_direct' } })).email,
      'erased-usr_direct@invalid.invalid'
    );
    assert.equal(
      await db.auditLog.count({ where: { tenantId: 'ten_account_a' } }),
      5
    );
    // An audit marker cannot certify a mixed restore that still retains scoped PII.
    await db.telegramSearchReference.create({
      data: {
        id: 'ref_retained_pii',
        tenantId: 'ten_account_a',
        storeId: 'sto_account_a',
        membershipId: 'mem_exclusive',
        telegramAccountId: 'tga_exclusive',
        telegramChatId: 10001n,
        purpose: 'PAGE',
        queryEncrypted: 'fixture-retained-query',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    assert.equal(await accounts.identityErasureComplete(userTarget), false);
    await assert.rejects(
      replayLedger(ledger, stores, db, true, accounts),
      /does not match/
    );
    await db.telegramSearchReference.delete({
      where: { id: 'ref_retained_pii' },
    });
    assert.equal(await accounts.identityErasureComplete(userTarget), true);
    const preMembershipLedger = join(directory, 'pre-membership-ledger.jsonl');
    await writeFile(preMembershipLedger, '', { mode: 0o600 });
    const preMembershipTarget = {
      tenantId: 'ten_account_b',
      userId: 'usr_pre_membership',
      emailSha256: privacyFingerprint('pre-membership@example.test'),
    };
    await db.user.create({
      data: {
        id: preMembershipTarget.userId,
        email: 'pre-membership@example.test',
        displayName: 'Before joining',
        passwordHash: 'fixture-hash',
      },
    });
    const preMembershipBackup = execFileSync('docker', [
      'exec',
      container,
      'pg_dump',
      '-U',
      'postgres',
      '-Fc',
      database,
    ]);
    await db.membership.create({
      data: {
        id: 'mem_pre_membership',
        tenantId: preMembershipTarget.tenantId,
        userId: preMembershipTarget.userId,
      },
    });
    await appendAccountLedger(preMembershipLedger, preMembershipTarget);
    await accounts.eraseIdentity(preMembershipTarget);
    await db.$disconnect();
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        container,
        'pg_restore',
        '-U',
        'postgres',
        '--clean',
        '--if-exists',
        '-d',
        database,
      ],
      { input: preMembershipBackup }
    );
    await db.$connect();
    assert.equal(
      await db.membership.findFirst({
        where: {
          tenantId: preMembershipTarget.tenantId,
          userId: preMembershipTarget.userId,
        },
      }),
      null
    );
    await assert.rejects(
      replayLedger(preMembershipLedger, stores, db, true, accounts),
      /without restored Membership/
    );
    assert.equal(
      (
        await db.user.findUniqueOrThrow({
          where: { id: preMembershipTarget.userId },
        })
      ).email,
      'pre-membership@example.test'
    );
    await db.user.delete({ where: { id: preMembershipTarget.userId } });
    assert.equal(
      (await replayLedger(preMembershipLedger, stores, db, true, accounts))
        .pending,
      0
    );
    const missingTenantLedger = join(directory, 'missing-tenant-ledger.jsonl');
    await writeFile(missingTenantLedger, '', { mode: 0o600 });
    await appendAccountLedger(missingTenantLedger, {
      tenantId: 'ten_not_yet_created',
      nameSha256: privacyFingerprint('Before tenant creation'),
    });
    await assert.rejects(
      replayLedger(missingTenantLedger, stores, db, true, accounts),
      /Tenant completion cannot be verified/
    );
    // Missing/expired proof cannot turn anonymized data into an automatic skip.
    await db.auditLog.deleteMany({
      where: { tenantId: 'ten_account_a', action: { startsWith: 'privacy.' } },
    });
    await assert.rejects(
      replayLedger(ledger, stores, db, true, accounts),
      /does not match/
    );
    await wrapperAcceptance(directory);
    console.log(
      'pilot account integration: PASS scoped-export linked-store ledger replay soft-deleted-target removed-member-cascade backup-restore-replay shared-removed-membership FK audit idempotency retained-scoped-pii-fail-closed audit-expiry-fail-closed pre-membership-restore-fail-closed absent-user-safe-skip absent-tenant-fail-closed'
    );
  } finally {
    await db.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const detail = String(error?.stack ?? error).replaceAll(url, '[test-db]');
  console.error(`pilot account integration: FAIL ${detail}`);
  process.exitCode = 1;
});
