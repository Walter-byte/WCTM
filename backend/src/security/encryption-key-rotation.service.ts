import { Injectable } from '@nestjs/common';
import { type Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { EncryptionService } from '../common/encryption/encryption.service';
import { PrismaService } from '../prisma/prisma.service';

const READ_BATCH_SIZE = 100;
const ROTATION_AUDIT_ACTION = 'security.application_encryption_key_rotated';

export type EncryptionKeyRotationMode = 'inspect' | 'rotate' | 'verify';

export interface EncryptionKeyRotationCounts {
  rows: number;
  values: number;
  current: number;
  previous: number;
  unreadable: number;
  updatedRows: number;
  updatedValues: number;
}

export interface EncryptionKeyRotationReport {
  mode: EncryptionKeyRotationMode;
  status: 'complete' | 'migration-required' | 'failed';
  passed: boolean;
  models: {
    Store: EncryptionKeyRotationCounts;
    TelegramCallbackReference: EncryptionKeyRotationCounts;
    TelegramSearchReference: EncryptionKeyRotationCounts;
  };
  total: EncryptionKeyRotationCounts;
}

type RotationModelName = keyof EncryptionKeyRotationReport['models'];

function emptyCounts(): EncryptionKeyRotationCounts {
  return {
    rows: 0,
    values: 0,
    current: 0,
    previous: 0,
    unreadable: 0,
    updatedRows: 0,
    updatedValues: 0,
  };
}

function addCounts(
  target: EncryptionKeyRotationCounts,
  source: EncryptionKeyRotationCounts
): void {
  for (const key of Object.keys(target) as Array<keyof typeof target>) {
    target[key] += source[key];
  }
}

@Injectable()
export class EncryptionKeyRotationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService
  ) {}

  async execute(
    mode: EncryptionKeyRotationMode
  ): Promise<EncryptionKeyRotationReport> {
    if (mode === 'rotate' && !this.encryption.hasPreviousKey()) {
      throw new Error(
        'APP_ENCRYPTION_PREVIOUS_KEY is required for encryption-key rotation'
      );
    }

    const preflight = await this.scan(mode);

    if (mode !== 'rotate' || preflight.total.unreadable > 0) {
      return preflight;
    }

    const updated = {
      Store: emptyCounts(),
      TelegramCallbackReference: emptyCounts(),
      TelegramSearchReference: emptyCounts(),
    };

    await this.rotateStores(updated.Store);
    await this.rotateCallbackReferences(updated.TelegramCallbackReference);
    await this.rotateSearchReferences(updated.TelegramSearchReference);

    const final = await this.scan(mode);

    for (const model of Object.keys(updated) as RotationModelName[]) {
      final.models[model].updatedRows = updated[model].updatedRows;
      final.models[model].updatedValues = updated[model].updatedValues;
    }
    final.total.updatedRows = Object.values(updated).reduce(
      (sum, counts) => sum + counts.updatedRows,
      0
    );
    final.total.updatedValues = Object.values(updated).reduce(
      (sum, counts) => sum + counts.updatedValues,
      0
    );

    return final;
  }

  private async scan(
    mode: EncryptionKeyRotationMode
  ): Promise<EncryptionKeyRotationReport> {
    const models = {
      Store: emptyCounts(),
      TelegramCallbackReference: emptyCounts(),
      TelegramSearchReference: emptyCounts(),
    };

    await this.scanStores(models.Store);
    await this.scanCallbackReferences(models.TelegramCallbackReference);
    await this.scanSearchReferences(models.TelegramSearchReference);

    const total = emptyCounts();
    for (const counts of Object.values(models)) {
      addCounts(total, counts);
    }

    const passed =
      total.unreadable === 0 && (mode === 'inspect' || total.previous === 0);
    const status =
      total.unreadable > 0
        ? 'failed'
        : total.previous > 0
          ? 'migration-required'
          : 'complete';

    return { mode, status, passed, models, total };
  }

  private classify(
    counts: EncryptionKeyRotationCounts,
    values: readonly string[]
  ): void {
    counts.rows += 1;
    counts.values += values.length;

    for (const value of values) {
      counts[this.encryption.keySource(value)] += 1;
    }
  }

  private async scanStores(counts: EncryptionKeyRotationCounts): Promise<void> {
    let cursor: string | undefined;

    do {
      const rows = await this.prisma.store.findMany({
        orderBy: { id: 'asc' },
        take: READ_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          consumerKeyEncrypted: true,
          consumerSecretEncrypted: true,
          webhookSecretEncrypted: true,
        },
      });

      for (const row of rows) {
        this.classify(counts, [
          row.consumerKeyEncrypted,
          row.consumerSecretEncrypted,
          ...(row.webhookSecretEncrypted ? [row.webhookSecretEncrypted] : []),
        ]);
      }

      cursor = rows.at(-1)?.id;
      if (rows.length < READ_BATCH_SIZE) {
        break;
      }
    } while (cursor);
  }

  private async scanCallbackReferences(
    counts: EncryptionKeyRotationCounts
  ): Promise<void> {
    let cursor: string | undefined;

    do {
      const rows = await this.prisma.telegramCallbackReference.findMany({
        where: { noteBodyEncrypted: { not: null } },
        orderBy: { id: 'asc' },
        take: READ_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, noteBodyEncrypted: true },
      });

      for (const row of rows) {
        if (row.noteBodyEncrypted) {
          this.classify(counts, [row.noteBodyEncrypted]);
        }
      }

      cursor = rows.at(-1)?.id;
      if (rows.length < READ_BATCH_SIZE) {
        break;
      }
    } while (cursor);
  }

  private async scanSearchReferences(
    counts: EncryptionKeyRotationCounts
  ): Promise<void> {
    let cursor: string | undefined;

    do {
      const rows = await this.prisma.telegramSearchReference.findMany({
        where: { queryEncrypted: { not: null } },
        orderBy: { id: 'asc' },
        take: READ_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, queryEncrypted: true },
      });

      for (const row of rows) {
        if (row.queryEncrypted) {
          this.classify(counts, [row.queryEncrypted]);
        }
      }

      cursor = rows.at(-1)?.id;
      if (rows.length < READ_BATCH_SIZE) {
        break;
      }
    } while (cursor);
  }

  private async rotateStores(
    counts: EncryptionKeyRotationCounts
  ): Promise<void> {
    await this.visitStoreIds(async (id) => {
      const updatedValues = await this.prisma.$transaction(
        async (transaction) => this.rotateStore(transaction, id)
      );
      if (updatedValues > 0) {
        counts.updatedRows += 1;
        counts.updatedValues += updatedValues;
      }
    });
  }

  private async rotateCallbackReferences(
    counts: EncryptionKeyRotationCounts
  ): Promise<void> {
    await this.visitCallbackReferenceIds(async (id) => {
      const updatedValues = await this.prisma.$transaction(
        async (transaction) => this.rotateCallbackReference(transaction, id)
      );
      if (updatedValues > 0) {
        counts.updatedRows += 1;
        counts.updatedValues += updatedValues;
      }
    });
  }

  private async rotateSearchReferences(
    counts: EncryptionKeyRotationCounts
  ): Promise<void> {
    await this.visitSearchReferenceIds(async (id) => {
      const updatedValues = await this.prisma.$transaction(
        async (transaction) => this.rotateSearchReference(transaction, id)
      );
      if (updatedValues > 0) {
        counts.updatedRows += 1;
        counts.updatedValues += updatedValues;
      }
    });
  }

  private async visitStoreIds(
    visit: (id: string) => Promise<void>
  ): Promise<void> {
    let cursor: string | undefined;

    do {
      const rows = await this.prisma.store.findMany({
        orderBy: { id: 'asc' },
        take: READ_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true },
      });
      for (const row of rows) {
        await visit(row.id);
      }
      cursor = rows.at(-1)?.id;
      if (rows.length < READ_BATCH_SIZE) break;
    } while (cursor);
  }

  private async visitCallbackReferenceIds(
    visit: (id: string) => Promise<void>
  ): Promise<void> {
    let cursor: string | undefined;

    do {
      const rows = await this.prisma.telegramCallbackReference.findMany({
        where: { noteBodyEncrypted: { not: null } },
        orderBy: { id: 'asc' },
        take: READ_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true },
      });
      for (const row of rows) {
        await visit(row.id);
      }
      cursor = rows.at(-1)?.id;
      if (rows.length < READ_BATCH_SIZE) break;
    } while (cursor);
  }

  private async visitSearchReferenceIds(
    visit: (id: string) => Promise<void>
  ): Promise<void> {
    let cursor: string | undefined;

    do {
      const rows = await this.prisma.telegramSearchReference.findMany({
        where: { queryEncrypted: { not: null } },
        orderBy: { id: 'asc' },
        take: READ_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true },
      });
      for (const row of rows) {
        await visit(row.id);
      }
      cursor = rows.at(-1)?.id;
      if (rows.length < READ_BATCH_SIZE) break;
    } while (cursor);
  }

  private async rotateStore(
    transaction: Prisma.TransactionClient,
    id: string
  ): Promise<number> {
    const row = await transaction.store.findUnique({
      where: { id },
      select: {
        id: true,
        tenantId: true,
        consumerKeyEncrypted: true,
        consumerSecretEncrypted: true,
        webhookSecretEncrypted: true,
      },
    });

    if (!row) {
      throw new Error('Encrypted row changed during rotation');
    }

    const consumerKey = this.encryption.reencryptWithCurrentKey(
      row.consumerKeyEncrypted
    );
    const consumerSecret = this.encryption.reencryptWithCurrentKey(
      row.consumerSecretEncrypted
    );
    const webhookSecret = row.webhookSecretEncrypted
      ? this.encryption.reencryptWithCurrentKey(row.webhookSecretEncrypted)
      : undefined;
    const updatedValues = [consumerKey, consumerSecret, webhookSecret].filter(
      (value) => value?.source === 'previous'
    ).length;

    if (updatedValues === 0) {
      return 0;
    }

    const updated = await transaction.store.updateMany({
      where: {
        id: row.id,
        consumerKeyEncrypted: row.consumerKeyEncrypted,
        consumerSecretEncrypted: row.consumerSecretEncrypted,
        webhookSecretEncrypted: row.webhookSecretEncrypted,
      },
      data: {
        consumerKeyEncrypted: consumerKey.encryptedValue,
        consumerSecretEncrypted: consumerSecret.encryptedValue,
        webhookSecretEncrypted: webhookSecret?.encryptedValue,
      },
    });

    await this.requireSingleUpdateAndAudit(transaction, updated.count, {
      tenantId: row.tenantId,
      entityType: 'Store',
      entityId: row.id,
      encryptedFieldCount: updatedValues,
    });

    return updatedValues;
  }

  private async rotateCallbackReference(
    transaction: Prisma.TransactionClient,
    id: string
  ): Promise<number> {
    const row = await transaction.telegramCallbackReference.findUnique({
      where: { id },
      select: { id: true, tenantId: true, noteBodyEncrypted: true },
    });

    if (!row?.noteBodyEncrypted) {
      return 0;
    }

    const reencrypted = this.encryption.reencryptWithCurrentKey(
      row.noteBodyEncrypted
    );
    if (reencrypted.source === 'current') {
      return 0;
    }

    const updated = await transaction.telegramCallbackReference.updateMany({
      where: { id: row.id, noteBodyEncrypted: row.noteBodyEncrypted },
      data: { noteBodyEncrypted: reencrypted.encryptedValue },
    });

    await this.requireSingleUpdateAndAudit(transaction, updated.count, {
      tenantId: row.tenantId,
      entityType: 'TelegramCallbackReference',
      entityId: row.id,
      encryptedFieldCount: 1,
    });

    return 1;
  }

  private async rotateSearchReference(
    transaction: Prisma.TransactionClient,
    id: string
  ): Promise<number> {
    const row = await transaction.telegramSearchReference.findUnique({
      where: { id },
      select: { id: true, tenantId: true, queryEncrypted: true },
    });

    if (!row?.queryEncrypted) {
      return 0;
    }

    const reencrypted = this.encryption.reencryptWithCurrentKey(
      row.queryEncrypted
    );
    if (reencrypted.source === 'current') {
      return 0;
    }

    const updated = await transaction.telegramSearchReference.updateMany({
      where: { id: row.id, queryEncrypted: row.queryEncrypted },
      data: { queryEncrypted: reencrypted.encryptedValue },
    });

    await this.requireSingleUpdateAndAudit(transaction, updated.count, {
      tenantId: row.tenantId,
      entityType: 'TelegramSearchReference',
      entityId: row.id,
      encryptedFieldCount: 1,
    });

    return 1;
  }

  private async requireSingleUpdateAndAudit(
    transaction: Prisma.TransactionClient,
    updatedCount: number,
    input: {
      tenantId: string;
      entityType: RotationModelName;
      entityId: string;
      encryptedFieldCount: number;
    }
  ): Promise<void> {
    if (updatedCount !== 1) {
      throw new Error('Encrypted row changed during rotation');
    }

    await transaction.auditLog.create({
      data: {
        id: `aud_${randomUUID()}`,
        tenantId: input.tenantId,
        userId: null,
        action: ROTATION_AUDIT_ACTION,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: { encryptedFieldCount: input.encryptedFieldCount },
      },
      select: { id: true },
    });
  }
}
