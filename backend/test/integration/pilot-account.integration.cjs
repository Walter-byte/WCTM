const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

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
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'wctm-account-ledger-'));
  try {
    const ledger = join(directory, 'erasure-ledger.jsonl');
    await writeFile(ledger, '', { mode: 0o600 });
    await db.tenant.createMany({
      data: [
        { id: 'ten_account_a', name: 'Account A' },
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
        },
        { id: 'mem_shared_a', tenantId: 'ten_account_a', userId: 'usr_shared' },
        { id: 'mem_shared_b', tenantId: 'ten_account_b', userId: 'usr_shared' },
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
      ['usr_exclusive', 'usr_shared']
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
    assert.equal(sharedMembership.deletedAt, null);
    assert.equal(
      await db.auditLog.count({ where: { tenantId: 'ten_account_a' } }),
      4
    );
    console.log(
      'pilot account integration: PASS scoped-export linked-store ledger replay shared-identity FK audit idempotency'
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
