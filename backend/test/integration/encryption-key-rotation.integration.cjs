const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { resolve } = require('node:path');

const { PrismaPg } = require('@prisma/adapter-pg');
const { MembershipRole, PrismaClient, StoreStatus } = require('@prisma/client');

const {
  EncryptionService,
} = require('../../dist/common/encryption/encryption.service');
const {
  RequestContextService,
} = require('../../dist/common/request-context/request-context.service');
const {
  TenantScopedPrismaService,
} = require('../../dist/tenant/tenant-scoped-prisma.service');
const {
  TenantContextService,
} = require('../../dist/tenant/tenant-context.service');
const { StoreService } = require('../../dist/store/store.service');

const databaseUrl = process.env.ROTATION_TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error('ROTATION_TEST_DATABASE_URL is required');
}

const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
if (!/^wctm_p71_rotation_[a-z0-9_]+$/.test(databaseName)) {
  throw new Error('Rotation integration requires a dedicated test database');
}

const plaintexts = {
  consumerKey: 'synthetic-consumer-key',
  consumerSecret: 'synthetic-consumer-secret',
  webhookSecret: 'synthetic-webhook-secret',
  noteBody: 'synthetic-note-body',
  searchQuery: 'synthetic-search-query',
};
const oldKey = randomBytes(32);
const newKey = randomBytes(32);
const keyConfiguration = (key, previousKey) => ({
  encryption: {
    key: key.toString('base64'),
    ...(previousKey ? { previousKey: previousKey.toString('base64') } : {}),
  },
});
const oldOnly = new EncryptionService(keyConfiguration(oldKey));
const newOnly = new EncryptionService(keyConfiguration(newKey));
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});

function childEnvironment(previousKey) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    JWT_ACCESS_TTL: '15m',
    APP_ENCRYPTION_KEY: newKey.toString('base64'),
    APP_ENCRYPTION_PREVIOUS_KEY: previousKey ? oldKey.toString('base64') : '',
    PILOT_MODE: 'false',
  };
}

function assertSecretSafe(output, ciphertexts) {
  for (const sensitive of [
    ...Object.values(plaintexts),
    oldKey.toString('base64'),
    newKey.toString('base64'),
    ...ciphertexts,
  ]) {
    assert.equal(output.includes(sensitive), false);
  }
}

function runChild(command, arguments_, environment) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(command, arguments_, {
      cwd: resolve(__dirname, '../..'),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', rejectChild);
    child.once('exit', (code, signal) =>
      resolveChild({ code, signal, stdout, stderr })
    );
  });
}

async function runRotationCli(mode, previousKey, ciphertexts) {
  const result = await runChild(
    process.execPath,
    [
      resolve(__dirname, '../../dist/security/encryption-key-rotation.cli.js'),
      mode,
    ],
    childEnvironment(previousKey)
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.code, 0, output);
  assertSecretSafe(output, ciphertexts);
  return JSON.parse(result.stdout);
}

async function listen(server) {
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  );
}

async function availablePort() {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('Backend exited before the health probe passed');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }

  throw new Error('Backend health probe did not pass');
}

async function restartBackendWithCurrentKeyOnly(ciphertexts) {
  const port = await availablePort();
  const child = spawn(
    process.execPath,
    [resolve(__dirname, '../../dist/main.js')],
    {
      cwd: resolve(__dirname, '../..'),
      env: { ...childEnvironment(false), PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });

  try {
    await waitForHealth(port, child);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolveExit) => child.once('exit', resolveExit));
  }

  assertSecretSafe(output, ciphertexts);
}

async function main() {
  let fakeWooServer;

  try {
    await prisma.$connect();
    const migrations = await prisma.$queryRaw`
      SELECT COUNT(*)::integer AS count
      FROM "_prisma_migrations"
      WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL
    `;
    assert.equal(migrations[0].count, 16);
    assert.equal(await prisma.tenant.count(), 0);

    fakeWooServer = http.createServer((request, response) => {
      const expectedAuthorization = `Basic ${Buffer.from(
        `${plaintexts.consumerKey}:${plaintexts.consumerSecret}`
      ).toString('base64')}`;
      if (
        request.url !== '/wp-json/wc/v3/system_status' ||
        request.headers.authorization !== expectedAuthorization
      ) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ store_name: 'Synthetic Store' }));
    });
    const fakeWooPort = await listen(fakeWooServer);

    await prisma.$transaction([
      prisma.user.create({
        data: {
          id: 'usr_rotation_integration',
          email: 'rotation-integration@example.invalid',
          displayName: 'Rotation Integration',
        },
      }),
      prisma.tenant.create({
        data: { id: 'ten_rotation_integration', name: 'Rotation Integration' },
      }),
    ]);
    await prisma.membership.create({
      data: {
        id: 'mem_rotation_integration',
        tenantId: 'ten_rotation_integration',
        userId: 'usr_rotation_integration',
        role: MembershipRole.OWNER,
      },
    });
    await prisma.store.create({
      data: {
        id: 'sto_rotation_integration',
        tenantId: 'ten_rotation_integration',
        name: 'Rotation Integration Store',
        baseUrl: `http://127.0.0.1:${fakeWooPort}`,
        status: StoreStatus.ACTIVE,
        consumerKeyEncrypted: oldOnly.encrypt(plaintexts.consumerKey),
        consumerSecretEncrypted: oldOnly.encrypt(plaintexts.consumerSecret),
        webhookSecretEncrypted: oldOnly.encrypt(plaintexts.webhookSecret),
        webhookEndpointKey: 'synthetic-endpoint-key',
        registrationTokenHash: 'a'.repeat(64),
        pluginSecretHash: 'b'.repeat(64),
      },
    });
    await prisma.telegramAccount.create({
      data: {
        id: 'tga_rotation_integration',
        telegramUserId: 900000001n,
        userId: 'usr_rotation_integration',
      },
    });
    await prisma.telegramCallbackReference.create({
      data: {
        id: 'tcr_rotation_integration',
        telegramAccountId: 'tga_rotation_integration',
        telegramChatId: 900000002n,
        tenantId: 'ten_rotation_integration',
        storeId: 'sto_rotation_integration',
        purpose: 'NOTE_CONFIRM',
        targetWcOrderId: '1001',
        backReferenceId: 'tcr_rotation_back',
        noteVisibility: 'INTERNAL',
        noteBodyEncrypted: oldOnly.encrypt(plaintexts.noteBody),
        noteContentFingerprint: 'c'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.telegramSearchReference.create({
      data: {
        id: 'tsr_rotation_integration',
        telegramAccountId: 'tga_rotation_integration',
        telegramChatId: 900000002n,
        tenantId: 'ten_rotation_integration',
        membershipId: 'mem_rotation_integration',
        storeId: 'sto_rotation_integration',
        purpose: 'PAGE',
        queryEncrypted: oldOnly.encrypt(plaintexts.searchQuery),
        pageOffset: 0,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const before = await prisma.store.findUniqueOrThrow({
      where: { id: 'sto_rotation_integration' },
    });
    const callbackBefore =
      await prisma.telegramCallbackReference.findUniqueOrThrow({
        where: { id: 'tcr_rotation_integration' },
      });
    const searchBefore = await prisma.telegramSearchReference.findUniqueOrThrow(
      {
        where: { id: 'tsr_rotation_integration' },
      }
    );
    const ciphertexts = [
      before.consumerKeyEncrypted,
      before.consumerSecretEncrypted,
      before.webhookSecretEncrypted,
      callbackBefore.noteBodyEncrypted,
      searchBefore.queryEncrypted,
    ].filter(Boolean);
    assert.equal(
      oldOnly.decrypt(before.consumerKeyEncrypted),
      plaintexts.consumerKey
    );

    const inspected = await runRotationCli('inspect', true, ciphertexts);
    assert.deepEqual(
      {
        status: inspected.status,
        rows: inspected.total.rows,
        values: inspected.total.values,
        previous: inspected.total.previous,
      },
      { status: 'migration-required', rows: 3, values: 5, previous: 5 }
    );

    const rotated = await runRotationCli('rotate', true, ciphertexts);
    assert.equal(rotated.status, 'complete');
    assert.equal(rotated.total.updatedRows, 3);
    assert.equal(rotated.total.updatedValues, 5);

    const after = await prisma.store.findUniqueOrThrow({
      where: { id: 'sto_rotation_integration' },
    });
    const callback = await prisma.telegramCallbackReference.findUniqueOrThrow({
      where: { id: 'tcr_rotation_integration' },
    });
    const search = await prisma.telegramSearchReference.findUniqueOrThrow({
      where: { id: 'tsr_rotation_integration' },
    });
    const rotatedCiphertexts = [
      after.consumerKeyEncrypted,
      after.consumerSecretEncrypted,
      after.webhookSecretEncrypted,
      callback.noteBodyEncrypted,
      search.queryEncrypted,
    ].filter(Boolean);
    assert.equal(
      newOnly.decrypt(after.consumerKeyEncrypted),
      plaintexts.consumerKey
    );
    assert.equal(
      newOnly.decrypt(after.consumerSecretEncrypted),
      plaintexts.consumerSecret
    );
    assert.equal(
      newOnly.decrypt(after.webhookSecretEncrypted),
      plaintexts.webhookSecret
    );
    assert.equal(
      newOnly.decrypt(callback.noteBodyEncrypted),
      plaintexts.noteBody
    );
    assert.equal(
      newOnly.decrypt(search.queryEncrypted),
      plaintexts.searchQuery
    );
    for (const value of rotatedCiphertexts) {
      assert.equal(oldOnly.keySource(value), 'unreadable');
    }
    assert.equal(after.webhookEndpointKey, before.webhookEndpointKey);
    assert.equal(after.registrationTokenHash, before.registrationTokenHash);
    assert.equal(after.pluginSecretHash, before.pluginSecretHash);

    const verified = await runRotationCli('verify', false, rotatedCiphertexts);
    assert.equal(verified.status, 'complete');
    assert.equal(verified.total.current, 5);
    assert.equal(verified.total.previous, 0);
    assert.equal(verified.total.unreadable, 0);

    const rerun = await runRotationCli('rotate', true, rotatedCiphertexts);
    assert.equal(rerun.status, 'complete');
    assert.equal(rerun.total.updatedRows, 0);
    assert.equal(rerun.total.updatedValues, 0);

    const requestContext = new RequestContextService();
    const tenantContext = new TenantContextService(requestContext);
    const tenantPrisma = new TenantScopedPrismaService(prisma, tenantContext);
    const configuration = {
      woocommerce: {
        rest: {
          maxAttempts: 1,
          attemptTimeoutMs: 2_000,
          totalTimeoutMs: 3_000,
          backoffBaseMs: 0,
          backoffFactor: 1,
          jitterRatio: 0,
        },
      },
    };
    const storeService = new StoreService(
      tenantPrisma,
      newOnly,
      { record: async () => undefined },
      configuration,
      tenantContext,
      { assertActive: async () => undefined }
    );
    const connection = await requestContext.run(
      'rotation-integration',
      async () => {
        tenantContext.set({
          tenantId: 'ten_rotation_integration',
          userId: 'usr_rotation_integration',
          membershipRole: MembershipRole.OWNER,
        });
        assert.equal((await storeService.findOne(after.id)).id, after.id);
        return storeService.testConnection(after.id);
      }
    );
    assert.deepEqual(connection, {
      success: true,
      storeName: 'Synthetic Store',
    });

    await restartBackendWithCurrentKeyOnly(rotatedCiphertexts);

    const auditCount = await prisma.auditLog.count({
      where: { action: 'security.application_encryption_key_rotated' },
    });
    assert.equal(auditCount, 3);
    process.stdout.write(
      JSON.stringify({
        migrations: 16,
        encryptedRows: 3,
        encryptedValues: 5,
        rotatedRows: 3,
        rotatedValues: 5,
        idempotentRerunUpdates: 0,
        currentOnlyVerification: 'PASS',
        backendRestart: 'PASS',
        storeRead: 'PASS',
        connectionTest: 'PASS',
        unrelatedStoreCredentials: 'UNCHANGED',
        secretSafeOutput: 'PASS',
      }) + '\n'
    );
  } finally {
    if (fakeWooServer) await close(fakeWooServer);
    await prisma.$disconnect();
  }
}

void main().catch(() => {
  process.stderr.write('Encryption-key rotation integration failed safely.\n');
  process.exitCode = 1;
});
