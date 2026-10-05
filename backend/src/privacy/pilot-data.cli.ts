import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, StoreStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { EncryptionService } from '../common/encryption/encryption.service';
import type { ApplicationConfigService } from '../config/application-config.service';
import { PilotDataService, type PilotTarget } from './pilot-data.service';
import { removeOwnedWooWebhooks } from './woo-webhook-cleanup';

type Mode =
  | 'inspect'
  | 'disconnect'
  | 'export'
  | 'prepare-erasure'
  | 'erase'
  | 'scrub'
  | 'replay';

interface Options {
  mode: Mode;
  target?: PilotTarget;
  execute: boolean;
  output?: string;
  ledger?: string;
}

function argument(name: string, args: string[]): string | undefined {
  const index = args.indexOf(name);
  return index < 0 || index + 1 >= args.length ? undefined : args[index + 1];
}

function parse(args: string[]): Options {
  const mode = args[0] as Mode;
  if (
    ![
      'inspect',
      'disconnect',
      'export',
      'prepare-erasure',
      'erase',
      'scrub',
      'replay',
    ].includes(mode)
  ) {
    throw new Error('privacy mode is invalid');
  }
  const execute = args.includes('--execute');
  const tenantId = argument('--tenant-id', args);
  const storeId = argument('--store-id', args);
  const baseUrl = argument('--base-url', args);
  const output = argument('--output', args);
  const ledger = argument('--ledger', args);
  if (
    mode !== 'replay' &&
    (!tenantId?.startsWith('ten_') ||
      !storeId?.startsWith('sto_') ||
      !baseUrl?.startsWith('https://'))
  ) {
    throw new Error('exact Tenant, Store and HTTPS base URL are required');
  }
  if (['export'].includes(mode) && (!output || !isAbsolute(output))) {
    throw new Error('export requires an absolute protected output path');
  }
  if (
    ['prepare-erasure', 'erase', 'replay'].includes(mode) &&
    (!ledger || !isAbsolute(ledger))
  ) {
    throw new Error('erasure requires an absolute external ledger path');
  }
  return {
    mode,
    execute,
    ...(mode === 'replay'
      ? {}
      : {
          target: { tenantId: tenantId!, storeId: storeId!, baseUrl: baseUrl! },
        }),
    ...(output ? { output } : {}),
    ...(ledger ? { ledger } : {}),
  };
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function verifyLedger(path: string): Promise<void> {
  if (resolve(path).startsWith(`${process.cwd()}/`)) {
    throw new Error('erasure ledger must be outside the repository');
  }
  const details = await stat(path);
  if (!details.isFile() || (details.mode & 0o077) !== 0) {
    throw new Error('erasure ledger must be a mode-0600 regular file');
  }
}

export async function appendLedger(
  path: string,
  target: PilotTarget
): Promise<void> {
  await verifyLedger(path);
  const handle = await open(path, 'a');
  try {
    await handle.writeFile(
      `${JSON.stringify({
        tenantId: target.tenantId,
        storeId: target.storeId,
        baseUrlSha256: fingerprint(target.baseUrl),
        requestedAt: new Date().toISOString(),
      })}\n`
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ledgerContains(
  path: string,
  target: PilotTarget
): Promise<boolean> {
  await verifyLedger(path);
  return (await readFile(path, 'utf8')).split('\n').some((line) => {
    if (!line) return false;
    const entry = JSON.parse(line) as Record<string, unknown>;
    return (
      entry['tenantId'] === target.tenantId &&
      entry['storeId'] === target.storeId &&
      entry['baseUrlSha256'] === fingerprint(target.baseUrl)
    );
  });
}

export async function replayLedger(
  path: string,
  service: PilotDataService,
  database: PrismaClient,
  execute: boolean
) {
  await verifyLedger(path);
  const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
  let pending = 0;
  for (const line of lines) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (
      typeof entry['tenantId'] !== 'string' ||
      typeof entry['storeId'] !== 'string' ||
      typeof entry['baseUrlSha256'] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry['baseUrlSha256'])
    ) {
      throw new Error('erasure ledger contains an invalid entry');
    }
    const store = await database.store.findFirst({
      where: { id: entry['storeId'], tenantId: entry['tenantId'] },
      select: { baseUrl: true, status: true },
    });
    if (!store) continue;
    if (
      store.baseUrl === `https://erased.invalid/${entry['storeId']}` &&
      store.status === StoreStatus.DISCONNECTED
    )
      continue;
    if (fingerprint(store.baseUrl) !== entry['baseUrlSha256']) {
      throw new Error(
        'erasure ledger target identity does not match restored Store'
      );
    }
    pending++;
    if (execute) {
      const target = {
        tenantId: entry['tenantId'],
        storeId: entry['storeId'],
        baseUrl: store.baseUrl,
      };
      await service.disconnect(target);
      await service.erase(target);
    }
  }
  return { ledgerEntries: lines.length, pending, executed: execute };
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  if (process.env['WCTM_PILOT_PRIVACY_OPERATION'] !== 'operator-approved') {
    throw new Error('operator-only privacy command is not enabled');
  }
  const databaseUrl = process.env['DATABASE_URL'];
  const key = process.env['APP_ENCRYPTION_KEY'];
  if (!databaseUrl || !key)
    throw new Error(
      'protected database and application key configuration is required'
    );
  const databaseIdentity = new URL(databaseUrl).username;
  if (
    !databaseIdentity ||
    decodeURIComponent(databaseIdentity) === 'wctm_runtime'
  ) {
    throw new Error(
      'privacy operation requires a distinct non-runtime database identity'
    );
  }
  const database = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  const encryption = new EncryptionService({
    encryption: { key, previousKey: undefined },
  } as ApplicationConfigService);
  const service = new PilotDataService(database, encryption);
  try {
    if (options.mode === 'replay') {
      process.stdout.write(
        `${JSON.stringify(await replayLedger(options.ledger!, service, database, options.execute))}\n`
      );
      return;
    }
    const target = options.target!;
    if (options.mode === 'inspect') {
      process.stdout.write(
        `${JSON.stringify(await service.inspect(target))}\n`
      );
    } else if (options.mode === 'disconnect') {
      let remoteWebhookCleanup = 'not-run';
      if (options.execute) {
        const credentials = await database.store.findFirst({
          where: {
            id: target.storeId,
            tenantId: target.tenantId,
            baseUrl: target.baseUrl,
          },
          select: {
            consumerKeyEncrypted: true,
            consumerSecretEncrypted: true,
            webhookEndpointKey: true,
          },
        });
        if (!credentials)
          throw new Error('privacy target changed before disconnect');
        let remoteInput;
        try {
          remoteInput = {
            baseUrl: target.baseUrl,
            endpointKey: credentials.webhookEndpointKey,
            consumerKey: encryption.decrypt(credentials.consumerKeyEncrypted),
            consumerSecret: encryption.decrypt(
              credentials.consumerSecretEncrypted
            ),
          };
        } catch {
          remoteInput = undefined;
        }
        await service.disconnect(target);
        remoteWebhookCleanup = remoteInput
          ? (await removeOwnedWooWebhooks(remoteInput)).complete
            ? 'complete'
            : 'manual-required'
          : 'manual-required';
      }
      process.stdout.write(
        `${JSON.stringify({ target: target.storeId, disconnected: options.execute, remoteWebhookCleanup })}\n`
      );
    } else if (options.mode === 'export') {
      const report = await service.export(target);
      await writeFile(options.output!, `${JSON.stringify(report)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      process.stdout.write('privacy export: PASS protected-file-created\n');
    } else if (options.mode === 'scrub') {
      process.stdout.write(
        `${JSON.stringify(await service.scrubHistorical(target, options.execute))}\n`
      );
    } else if (options.mode === 'prepare-erasure' || options.mode === 'erase') {
      const report = await service.inspect(target);
      if (!report.disconnected || report.status !== StoreStatus.DISCONNECTED) {
        throw new Error('privacy erasure requires verified disconnect first');
      }
      if (options.execute) {
        if (options.mode === 'prepare-erasure') {
          await appendLedger(options.ledger!, target);
        } else {
          if (!(await ledgerContains(options.ledger!, target))) {
            throw new Error(
              'erasure ledger does not contain the verified target'
            );
          }
          await service.erase(target);
        }
      }
      process.stdout.write(
        `${JSON.stringify({ target: target.storeId, prepared: options.mode === 'prepare-erasure' && options.execute, erased: options.mode === 'erase' && options.execute, counts: report.counts })}\n`
      );
    }
  } finally {
    await database.$disconnect();
  }
}

if (require.main === module) {
  void main().catch(() => {
    process.stderr.write(
      'pilot privacy operation failed; inspect protected operator records\n'
    );
    process.exitCode = 1;
  });
}
