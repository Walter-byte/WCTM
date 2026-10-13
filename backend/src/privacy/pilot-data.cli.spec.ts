import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { PrismaClient, StoreStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  accountLedgerContains,
  appendAccountLedger,
  appendLedger,
  replayLedger,
  requireStoreLedgerEntries,
  verifyExportOutput,
} from './pilot-data.cli';
import type { PilotDataService } from './pilot-data.service';
import {
  PilotAccountService,
  privacyFingerprint,
} from './pilot-account.service';

const target = {
  tenantId: 'ten_a',
  storeId: 'sto_a',
  baseUrl: 'https://shop.example.test',
};
const directories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'wctm-erasure-'));
  directories.push(directory);
  const ledger = join(directory, 'ledger.jsonl');
  await writeFile(ledger, '', { mode: 0o600 });
  return ledger;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('external erasure ledger replay', () => {
  it('records only scoped identity hashes and replays a restored Store before resumption', async () => {
    const ledger = await fixture();
    await appendLedger(ledger, target);
    const content = await readFile(ledger, 'utf8');
    expect(content).not.toContain(target.baseUrl);
    const disconnect = jest.fn(async () => undefined);
    const erase = jest.fn(async () => undefined);
    const service = { disconnect, erase } as unknown as PilotDataService;
    const database = {
      store: {
        findFirst: jest.fn(async () => ({
          baseUrl: target.baseUrl,
          status: StoreStatus.ACTIVE,
        })),
      },
    } as unknown as PrismaClient;

    await expect(
      replayLedger(ledger, service, database, false)
    ).resolves.toMatchObject({
      pending: 1,
      executed: false,
    });
    expect(disconnect).not.toHaveBeenCalled();
    await expect(
      replayLedger(ledger, service, database, true)
    ).resolves.toMatchObject({
      pending: 1,
      executed: true,
    });
    expect(disconnect).toHaveBeenCalledWith(target);
    expect(erase).toHaveBeenCalledWith(target);
    expect(disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      erase.mock.invocationCallOrder[0]!
    );
  });

  it('fails closed when restored Store identity differs', async () => {
    const ledger = await fixture();
    await appendLedger(ledger, target);
    const database = {
      store: {
        findFirst: jest.fn(async () => ({
          baseUrl: 'https://other.example.test',
          status: StoreStatus.ACTIVE,
        })),
      },
    } as unknown as PrismaClient;
    const service = {
      disconnect: jest.fn(),
      erase: jest.fn(),
    } as unknown as PilotDataService;
    await expect(replayLedger(ledger, service, database, true)).rejects.toThrow(
      'does not match'
    );
    expect(service.disconnect).not.toHaveBeenCalled();
  });

  it('replays exact User and Tenant entries after restore without storing names or email', async () => {
    const ledger = await fixture();
    const user = {
      tenantId: 'ten_a',
      userId: 'usr_a',
      emailSha256: privacyFingerprint('owner@example.test'),
    };
    const tenant = {
      tenantId: 'ten_a',
      nameSha256: privacyFingerprint('Pilot shop'),
    };
    await appendAccountLedger(ledger, user);
    await appendAccountLedger(ledger, tenant);
    expect(await accountLedgerContains(ledger, user)).toBe(true);
    expect(await accountLedgerContains(ledger, tenant)).toBe(true);
    const content = await readFile(ledger, 'utf8');
    expect(content).not.toContain('owner@example.test');
    expect(content).not.toContain('Pilot shop');
    const database = {
      membership: {
        findFirst: jest.fn(async () => ({
          deletedAt: null,
          user: { email: 'owner@example.test' },
        })),
      },
      tenant: {
        findFirst: jest.fn(async () => ({
          name: 'Pilot shop',
          deletedAt: null,
        })),
      },
    } as unknown as PrismaClient;
    const accounts = {
      eraseIdentity: jest.fn(async () => ({ userId: 'usr_a', shared: false })),
      eraseTenant: jest.fn(async () => ({ users: 1, sharedUsersRetained: 0 })),
    } as unknown as PilotAccountService;
    const stores = {} as PilotDataService;
    await expect(
      replayLedger(ledger, stores, database, false, accounts)
    ).resolves.toMatchObject({ pending: 2, executed: false });
    expect(accounts.eraseIdentity).not.toHaveBeenCalled();
    await expect(
      replayLedger(ledger, stores, database, true, accounts)
    ).resolves.toMatchObject({ pending: 2, executed: true });
    expect(accounts.eraseIdentity).toHaveBeenCalledWith(user);
    expect(accounts.eraseTenant).toHaveBeenCalledWith(tenant);
  });

  it('requires a matching Store ledger before whole-Tenant erasure', async () => {
    const ledger = await fixture();
    await expect(
      requireStoreLedgerEntries(ledger, 'ten_a', ['sto_a'])
    ).rejects.toThrow('linked Store');
    await appendLedger(ledger, target);
    await expect(
      requireStoreLedgerEntries(ledger, 'ten_a', ['sto_a'])
    ).resolves.toBeUndefined();
    await expect(
      requireStoreLedgerEntries(ledger, 'ten_b', ['sto_a'])
    ).rejects.toThrow('linked Store');
  });

  it('rejects a restored User identity mismatch before execution', async () => {
    const ledger = await fixture();
    await appendAccountLedger(ledger, {
      tenantId: 'ten_a',
      userId: 'usr_a',
      emailSha256: privacyFingerprint('owner@example.test'),
    });
    const database = {
      membership: {
        findFirst: jest.fn(async () => ({
          deletedAt: null,
          user: { email: 'different@example.test' },
        })),
      },
    } as unknown as PrismaClient;
    const accounts = {
      eraseIdentity: jest.fn(),
    } as unknown as PilotAccountService;
    await expect(
      replayLedger(ledger, {} as PilotDataService, database, true, accounts)
    ).rejects.toThrow('does not match');
    expect(accounts.eraseIdentity).not.toHaveBeenCalled();
  });
});

describe('protected privacy export path', () => {
  it('accepts only the exact Tenant/Store artifact contract beside the ledger', async () => {
    const ledger = await fixture();
    const directory = join(ledger, '..');
    const scope = createHash('sha256')
      .update(`${target.tenantId}\0${target.storeId}`)
      .digest('hex');
    const name = `wctm-privacy-export-${scope}-${Date.now()}-0123456789abcdef.json`;
    await expect(
      verifyExportOutput(join(directory, name), ledger, target)
    ).resolves.toBeUndefined();
    await expect(
      verifyExportOutput(
        join(directory, 'erasure-ledger.jsonl'),
        ledger,
        target
      )
    ).rejects.toThrow('scoped artifact contract');
    await expect(
      verifyExportOutput(join(directory, '..', name), ledger, target)
    ).rejects.toThrow('scoped artifact contract');
    await expect(
      verifyExportOutput(
        join(directory, name.replace(scope, '0'.repeat(64))),
        ledger,
        target
      )
    ).rejects.toThrow('scoped artifact contract');
    const link = join(directory, 'linked');
    await symlink(directory, link);
    await expect(
      verifyExportOutput(join(link, name), ledger, target)
    ).rejects.toThrow('scoped artifact contract');
    await expect(
      verifyExportOutput(`${link}/../${name}`, ledger, target)
    ).rejects.toThrow('scoped artifact contract');
  });
});
