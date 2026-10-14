import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, StoreStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import { EncryptionService } from '../common/encryption/encryption.service';
import type { ApplicationConfigService } from '../config/application-config.service';
import { PilotDataService, type PilotTarget } from './pilot-data.service';
import {
  PilotAccountService,
  privacyFingerprint,
  type IdentityPrivacyTarget,
  type TenantPrivacyTarget,
} from './pilot-account.service';
import { removeOwnedWooWebhooks } from './woo-webhook-cleanup';

type Mode =
  | 'inspect'
  | 'disconnect'
  | 'export'
  | 'prepare-erasure'
  | 'erase'
  | 'scrub'
  | 'tenant-inspect'
  | 'tenant-export'
  | 'tenant-prepare-erasure'
  | 'tenant-erase'
  | 'identity-inspect'
  | 'identity-export'
  | 'identity-prepare-erasure'
  | 'identity-erase'
  | 'replay';

interface Options {
  mode: Mode;
  target?: PilotTarget;
  tenantTarget?: TenantPrivacyTarget;
  identityTarget?: IdentityPrivacyTarget;
  execute: boolean;
  output?: string;
  ledger?: string;
  connectorOrigin?: string;
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
      'tenant-inspect',
      'tenant-export',
      'tenant-prepare-erasure',
      'tenant-erase',
      'identity-inspect',
      'identity-export',
      'identity-prepare-erasure',
      'identity-erase',
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
  const connectorOrigin = argument('--connector-origin', args);
  const accountMode =
    mode.startsWith('tenant-') || mode.startsWith('identity-');
  const tenantNameHash = argument('--name-sha256', args);
  const emailHash = argument('--email-sha256', args);
  const userId = argument('--user-id', args);
  if (
    !accountMode &&
    mode !== 'replay' &&
    (!tenantId?.startsWith('ten_') ||
      !storeId?.startsWith('sto_') ||
      !baseUrl?.startsWith('https://'))
  ) {
    throw new Error('exact Tenant, Store and HTTPS base URL are required');
  }
  if (
    mode.startsWith('tenant-') &&
    (!tenantId?.startsWith('ten_') ||
      !/^[0-9a-f]{64}$/.test(tenantNameHash ?? ''))
  ) {
    throw new Error('exact Tenant ID and name SHA-256 are required');
  }
  if (
    mode.startsWith('identity-') &&
    (!tenantId?.startsWith('ten_') ||
      !userId?.startsWith('usr_') ||
      !/^[0-9a-f]{64}$/.test(emailHash ?? ''))
  ) {
    throw new Error('exact Tenant, User and email SHA-256 are required');
  }
  if (
    ['export', 'tenant-export', 'identity-export'].includes(mode) &&
    (!output || !isAbsolute(output))
  ) {
    throw new Error('export requires an absolute protected output path');
  }
  if (
    ['export', 'tenant-export', 'identity-export'].includes(mode) &&
    (!ledger || !isAbsolute(ledger))
  ) {
    throw new Error('export requires the protected privacy directory');
  }
  if (
    ['export', 'tenant-export', 'identity-export'].includes(mode) &&
    !args.includes('--retain-for-delivery')
  ) {
    throw new Error('export requires explicit delivery retention');
  }
  if (
    [
      'prepare-erasure',
      'erase',
      'tenant-prepare-erasure',
      'tenant-erase',
      'identity-prepare-erasure',
      'identity-erase',
      'replay',
    ].includes(mode) &&
    (!ledger || !isAbsolute(ledger))
  ) {
    throw new Error('erasure requires an absolute external ledger path');
  }
  return {
    mode,
    execute,
    ...(!accountMode && mode !== 'replay'
      ? {
          target: { tenantId: tenantId!, storeId: storeId!, baseUrl: baseUrl! },
        }
      : {}),
    ...(mode.startsWith('tenant-')
      ? { tenantTarget: { tenantId: tenantId!, nameSha256: tenantNameHash! } }
      : {}),
    ...(mode.startsWith('identity-')
      ? {
          identityTarget: {
            tenantId: tenantId!,
            userId: userId!,
            emailSha256: emailHash!,
          },
        }
      : {}),
    ...(output ? { output } : {}),
    ...(ledger ? { ledger } : {}),
    ...(connectorOrigin ? { connectorOrigin } : {}),
  };
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function verifyExportOutput(
  output: string,
  ledger: string,
  target: { tenantId: string; storeId: string }
): Promise<void> {
  const scope = createHash('sha256')
    .update(`${target.tenantId}\0${target.storeId}`)
    .digest('hex');
  if (
    !new RegExp(
      `^wctm-privacy-export-${scope}-[0-9]{13}-[0-9a-f]{16}\\.json$`
    ).test(basename(output)) ||
    output !== resolve(output) ||
    resolve(dirname(output)) !== resolve(dirname(ledger))
  ) {
    throw new Error(
      'privacy export path is outside the scoped artifact contract'
    );
  }
  const directory = await lstat(dirname(ledger));
  if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700) {
    throw new Error('privacy export directory must be protected');
  }
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

export async function appendAccountLedger(
  path: string,
  target: TenantPrivacyTarget | IdentityPrivacyTarget
): Promise<void> {
  await verifyLedger(path);
  const entry =
    'userId' in target
      ? {
          kind: 'identity',
          tenantId: target.tenantId,
          userId: target.userId,
          emailSha256: target.emailSha256,
        }
      : {
          kind: 'tenant',
          tenantId: target.tenantId,
          nameSha256: target.nameSha256,
        };
  const handle = await open(path, 'a');
  try {
    await handle.writeFile(
      `${JSON.stringify({
        ...entry,
        requestedAt: new Date().toISOString(),
      })}\n`
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function accountLedgerContains(
  path: string,
  target: TenantPrivacyTarget | IdentityPrivacyTarget
): Promise<boolean> {
  await verifyLedger(path);
  return (await readFile(path, 'utf8')).split('\n').some((line) => {
    if (!line) return false;
    const entry = JSON.parse(line) as Record<string, unknown>;
    return 'userId' in target
      ? entry['kind'] === 'identity' &&
          entry['tenantId'] === target.tenantId &&
          entry['userId'] === target.userId &&
          entry['emailSha256'] === target.emailSha256
      : entry['kind'] === 'tenant' &&
          entry['tenantId'] === target.tenantId &&
          entry['nameSha256'] === target.nameSha256;
  });
}

export async function requireStoreLedgerEntries(
  path: string,
  tenantId: string,
  storeIds: string[]
): Promise<void> {
  await verifyLedger(path);
  const entries = (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const storeId of storeIds) {
    if (
      !entries.some(
        (entry) =>
          entry['kind'] === undefined &&
          entry['tenantId'] === tenantId &&
          entry['storeId'] === storeId &&
          typeof entry['baseUrlSha256'] === 'string' &&
          /^[0-9a-f]{64}$/.test(entry['baseUrlSha256'])
      )
    )
      throw new Error(
        'linked Store is missing its protected erasure ledger entry'
      );
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
  execute: boolean,
  accounts?: PilotAccountService
) {
  await verifyLedger(path);
  const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
  let pending = 0;
  for (const line of lines) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (entry['kind'] === 'tenant') {
      if (
        !accounts ||
        typeof entry['tenantId'] !== 'string' ||
        typeof entry['nameSha256'] !== 'string' ||
        !/^[0-9a-f]{64}$/.test(entry['nameSha256'])
      )
        throw new Error('erasure ledger contains an invalid Tenant entry');
      const tenant = await database.tenant.findFirst({
        where: { id: entry['tenantId'] },
        select: { name: true, deletedAt: true },
      });
      if (!tenant)
        throw new Error(
          'erasure ledger Tenant completion cannot be verified in restored data'
        );
      if (
        await accounts.tenantErasureComplete({
          tenantId: entry['tenantId'],
          nameSha256: entry['nameSha256'],
        })
      )
        continue;
      if (privacyFingerprint(tenant.name) !== entry['nameSha256'])
        throw new Error(
          'erasure ledger Tenant identity does not match restored data'
        );
      pending++;
      if (execute)
        await accounts.eraseTenant({
          tenantId: entry['tenantId'],
          nameSha256: entry['nameSha256'],
        });
      continue;
    }
    if (entry['kind'] === 'identity') {
      if (
        !accounts ||
        typeof entry['tenantId'] !== 'string' ||
        typeof entry['userId'] !== 'string' ||
        typeof entry['emailSha256'] !== 'string' ||
        !/^[0-9a-f]{64}$/.test(entry['emailSha256'])
      )
        throw new Error('erasure ledger contains an invalid User entry');
      const membership = await database.membership.findFirst({
        where: { tenantId: entry['tenantId'], userId: entry['userId'] },
        select: { deletedAt: true, user: { select: { email: true } } },
      });
      if (!membership) {
        const user = await database.user.findUnique({
          where: { id: entry['userId'] },
          select: { id: true },
        });
        if (!user) continue;
        throw new Error(
          'erasure ledger User completion cannot be verified without restored Membership'
        );
      }
      if (
        await accounts.identityErasureComplete({
          tenantId: entry['tenantId'],
          userId: entry['userId'],
          emailSha256: entry['emailSha256'],
        })
      )
        continue;
      if (privacyFingerprint(membership.user.email) !== entry['emailSha256'])
        throw new Error(
          'erasure ledger User identity does not match restored data'
        );
      pending++;
      if (execute)
        await accounts.eraseIdentity({
          tenantId: entry['tenantId'],
          userId: entry['userId'],
          emailSha256: entry['emailSha256'],
        });
      continue;
    }
    if (entry['kind'] !== undefined)
      throw new Error('erasure ledger contains an unknown entry type');
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
  const accounts = new PilotAccountService(database);
  try {
    if (options.mode === 'replay') {
      process.stdout.write(
        `${safeJson(await replayLedger(options.ledger!, service, database, options.execute, accounts))}\n`
      );
      return;
    }
    if (options.tenantTarget || options.identityTarget) {
      const tenant = options.tenantTarget;
      const identity = options.identityTarget;
      const report = tenant
        ? await accounts.inspectTenant(tenant)
        : await accounts.inspectIdentity(identity!);
      if (options.mode.endsWith('-inspect')) {
        process.stdout.write(`${safeJson(report)}\n`);
      } else if (options.mode.endsWith('-export')) {
        await verifyExportOutput(options.output!, options.ledger!, {
          tenantId: (tenant ?? identity)!.tenantId,
          storeId: tenant ? 'acc_tenant' : identity!.userId,
        });
        const exported = tenant
          ? await accounts.exportTenant(tenant)
          : await accounts.exportIdentity(identity!);
        await writeFile(options.output!, `${safeJson(exported)}\n`, {
          flag: 'wx',
          mode: 0o600,
        });
        process.stdout.write('privacy export: PASS protected-file-created\n');
      } else if (options.mode.endsWith('-prepare-erasure')) {
        if (tenant) {
          const tenantReport = await accounts.inspectTenant(tenant);
          if (tenantReport.stores.some((store) => !store.erased))
            throw new Error('erase each linked Store before Tenant erasure');
          await requireStoreLedgerEntries(
            options.ledger!,
            tenant.tenantId,
            tenantReport.stores.map((store) => store.id)
          );
        }
        if (options.execute)
          await appendAccountLedger(options.ledger!, tenant ?? identity!);
        process.stdout.write(
          `${safeJson({ prepared: options.execute, report })}\n`
        );
      } else if (options.mode.endsWith('-erase')) {
        if (options.execute) {
          if (tenant) {
            const tenantReport = await accounts.inspectTenant(tenant);
            await requireStoreLedgerEntries(
              options.ledger!,
              tenant.tenantId,
              tenantReport.stores.map((store) => store.id)
            );
          }
          if (
            !(await accountLedgerContains(options.ledger!, tenant ?? identity!))
          )
            throw new Error(
              'erasure ledger does not contain the verified account identity'
            );
          const result = tenant
            ? await accounts.eraseTenant(tenant)
            : await accounts.eraseIdentity(identity!);
          process.stdout.write(`${safeJson({ erased: true, result })}\n`);
        } else {
          process.stdout.write(`${safeJson({ erased: false, report })}\n`);
        }
      }
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
          remoteInput = options.connectorOrigin
            ? {
                baseUrl: target.baseUrl,
                connectorOrigin: options.connectorOrigin,
                endpointKey: credentials.webhookEndpointKey,
                consumerKey: encryption.decrypt(
                  credentials.consumerKeyEncrypted
                ),
                consumerSecret: encryption.decrypt(
                  credentials.consumerSecretEncrypted
                ),
              }
            : undefined;
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
      await verifyExportOutput(options.output!, options.ledger!, target);
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

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, candidate: unknown) =>
    typeof candidate === 'bigint' ? candidate.toString() : candidate
  );
}

if (require.main === module) {
  void main().catch(() => {
    process.stderr.write(
      'pilot privacy operation failed; inspect protected operator records\n'
    );
    process.exitCode = 1;
  });
}
