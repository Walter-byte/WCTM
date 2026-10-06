import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { PrismaClient, StoreStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendLedger,
  replayLedger,
  verifyExportOutput,
} from './pilot-data.cli';
import type { PilotDataService } from './pilot-data.service';

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
