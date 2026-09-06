import { describe, expect, it } from '@jest/globals';

import { EncryptionService } from '../common/encryption/encryption.service';
import type { ApplicationConfigService } from '../config/application-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import { EncryptionKeyRotationService } from './encryption-key-rotation.service';

interface StoreRow {
  id: string;
  tenantId: string;
  consumerKeyEncrypted: string;
  consumerSecretEncrypted: string;
  webhookSecretEncrypted: string | null;
}

interface CallbackRow {
  id: string;
  tenantId: string;
  noteBodyEncrypted: string | null;
}

interface SearchRow {
  id: string;
  tenantId: string;
  queryEncrypted: string | null;
}

interface FindManyArguments {
  cursor?: { id: string };
  skip?: number;
  take: number;
}

function pageById<T extends { id: string }>(
  rows: readonly T[],
  arguments_: FindManyArguments
): T[] {
  const ordered = [...rows].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const cursorIndex = arguments_.cursor
    ? ordered.findIndex((row) => row.id === arguments_.cursor?.id)
    : -1;
  const start = cursorIndex < 0 ? 0 : cursorIndex + (arguments_.skip ?? 0);

  return ordered.slice(start, start + arguments_.take);
}

class FakePrisma {
  stores: StoreRow[];
  callbacks: CallbackRow[];
  searches: SearchRow[];
  audits: Array<Record<string, unknown>> = [];
  failEntityOnce?:
    'Store' | 'TelegramCallbackReference' | 'TelegramSearchReference';

  constructor(input: {
    stores: StoreRow[];
    callbacks: CallbackRow[];
    searches: SearchRow[];
  }) {
    this.stores = structuredClone(input.stores);
    this.callbacks = structuredClone(input.callbacks);
    this.searches = structuredClone(input.searches);
  }

  store = {
    findMany: async (arguments_: FindManyArguments): Promise<StoreRow[]> =>
      pageById(this.stores, arguments_),
    findUnique: async (arguments_: {
      where: { id: string };
    }): Promise<StoreRow | null> =>
      this.stores.find((row) => row.id === arguments_.where.id) ?? null,
    updateMany: async (arguments_: {
      where: StoreRow;
      data: Partial<StoreRow>;
    }): Promise<{ count: number }> => {
      this.failIfRequested('Store');
      const row = this.stores.find(
        (candidate) =>
          candidate.id === arguments_.where.id &&
          candidate.consumerKeyEncrypted ===
            arguments_.where.consumerKeyEncrypted &&
          candidate.consumerSecretEncrypted ===
            arguments_.where.consumerSecretEncrypted &&
          candidate.webhookSecretEncrypted ===
            arguments_.where.webhookSecretEncrypted
      );
      if (!row) return { count: 0 };
      this.assignDefined(row, arguments_.data);
      return { count: 1 };
    },
  };

  telegramCallbackReference = {
    findMany: async (arguments_: FindManyArguments): Promise<CallbackRow[]> =>
      pageById(
        this.callbacks.filter((row) => row.noteBodyEncrypted !== null),
        arguments_
      ),
    findUnique: async (arguments_: {
      where: { id: string };
    }): Promise<CallbackRow | null> =>
      this.callbacks.find((row) => row.id === arguments_.where.id) ?? null,
    updateMany: async (arguments_: {
      where: { id: string; noteBodyEncrypted: string };
      data: Partial<CallbackRow>;
    }): Promise<{ count: number }> => {
      this.failIfRequested('TelegramCallbackReference');
      const row = this.callbacks.find(
        (candidate) =>
          candidate.id === arguments_.where.id &&
          candidate.noteBodyEncrypted === arguments_.where.noteBodyEncrypted
      );
      if (!row) return { count: 0 };
      this.assignDefined(row, arguments_.data);
      return { count: 1 };
    },
  };

  telegramSearchReference = {
    findMany: async (arguments_: FindManyArguments): Promise<SearchRow[]> =>
      pageById(
        this.searches.filter((row) => row.queryEncrypted !== null),
        arguments_
      ),
    findUnique: async (arguments_: {
      where: { id: string };
    }): Promise<SearchRow | null> =>
      this.searches.find((row) => row.id === arguments_.where.id) ?? null,
    updateMany: async (arguments_: {
      where: { id: string; queryEncrypted: string };
      data: Partial<SearchRow>;
    }): Promise<{ count: number }> => {
      this.failIfRequested('TelegramSearchReference');
      const row = this.searches.find(
        (candidate) =>
          candidate.id === arguments_.where.id &&
          candidate.queryEncrypted === arguments_.where.queryEncrypted
      );
      if (!row) return { count: 0 };
      this.assignDefined(row, arguments_.data);
      return { count: 1 };
    },
  };

  auditLog = {
    create: async (arguments_: {
      data: Record<string, unknown>;
    }): Promise<{ id: string }> => {
      this.audits.push(structuredClone(arguments_.data));
      return { id: String(arguments_.data['id']) };
    },
  };

  async $transaction<T>(
    operation: (transaction: FakePrisma) => Promise<T>
  ): Promise<T> {
    const snapshot = {
      stores: structuredClone(this.stores),
      callbacks: structuredClone(this.callbacks),
      searches: structuredClone(this.searches),
      audits: structuredClone(this.audits),
    };

    try {
      return await operation(this);
    } catch (error) {
      this.stores = snapshot.stores;
      this.callbacks = snapshot.callbacks;
      this.searches = snapshot.searches;
      this.audits = snapshot.audits;
      throw error;
    }
  }

  private failIfRequested(entity: FakePrisma['failEntityOnce']): void {
    if (this.failEntityOnce === entity) {
      this.failEntityOnce = undefined;
      throw new Error('Synthetic interruption');
    }
  }

  private assignDefined<T extends object>(target: T, source: Partial<T>): void {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) {
        Object.assign(target, { [key]: value });
      }
    }
  }
}

function encryption(key: Buffer, previousKey?: Buffer): EncryptionService {
  return new EncryptionService({
    encryption: {
      key: key.toString('base64'),
      ...(previousKey ? { previousKey: previousKey.toString('base64') } : {}),
    },
  } as ApplicationConfigService);
}

function fixture(): {
  database: FakePrisma;
  oldOnly: EncryptionService;
  dualKey: EncryptionService;
  newOnly: EncryptionService;
} {
  const oldKey = Buffer.alloc(32, 31);
  const newKey = Buffer.alloc(32, 37);
  const oldOnly = encryption(oldKey);
  const database = new FakePrisma({
    stores: [
      {
        id: 'sto_rotation',
        tenantId: 'ten_rotation',
        consumerKeyEncrypted: oldOnly.encrypt('synthetic-consumer-key'),
        consumerSecretEncrypted: oldOnly.encrypt('synthetic-consumer-secret'),
        webhookSecretEncrypted: oldOnly.encrypt('synthetic-webhook-secret'),
      },
    ],
    callbacks: [
      {
        id: 'tcr_rotation',
        tenantId: 'ten_rotation',
        noteBodyEncrypted: oldOnly.encrypt('synthetic-note-body'),
      },
    ],
    searches: [
      {
        id: 'tsr_rotation',
        tenantId: 'ten_rotation',
        queryEncrypted: oldOnly.encrypt('synthetic-search-query'),
      },
    ],
  });

  return {
    database,
    oldOnly,
    dualKey: encryption(newKey, oldKey),
    newOnly: encryption(newKey),
  };
}

function service(
  database: FakePrisma,
  encryptionService: EncryptionService
): EncryptionKeyRotationService {
  return new EncryptionKeyRotationService(
    database as unknown as PrismaService,
    encryptionService
  );
}

function encryptedValues(database: FakePrisma): string[] {
  const store = database.stores[0]!;
  return [
    store.consumerKeyEncrypted,
    store.consumerSecretEncrypted,
    store.webhookSecretEncrypted!,
    database.callbacks[0]!.noteBodyEncrypted!,
    database.searches[0]!.queryEncrypted!,
  ];
}

describe('EncryptionKeyRotationService', () => {
  it('inspects all exact encrypted fields using counts only', async () => {
    const { database, dualKey } = fixture();
    const report = await service(database, dualKey).execute('inspect');
    const serialized = JSON.stringify(report);

    expect(report).toMatchObject({
      status: 'migration-required',
      passed: true,
      total: {
        rows: 3,
        values: 5,
        current: 0,
        previous: 5,
        unreadable: 0,
      },
    });
    expect(serialized).not.toContain('synthetic-');
    for (const value of encryptedValues(database)) {
      expect(serialized).not.toContain(value);
    }
  });

  it('rotates every affected row transactionally and is idempotent', async () => {
    const { database, oldOnly, dualKey, newOnly } = fixture();
    const rotation = service(database, dualKey);
    const first = await rotation.execute('rotate');

    expect(first).toMatchObject({
      status: 'complete',
      passed: true,
      total: {
        values: 5,
        current: 5,
        previous: 0,
        unreadable: 0,
        updatedRows: 3,
        updatedValues: 5,
      },
    });
    expect(database.audits).toHaveLength(3);
    for (const value of encryptedValues(database)) {
      expect(newOnly.keySource(value)).toBe('current');
      expect(oldOnly.keySource(value)).toBe('unreadable');
    }

    const second = await rotation.execute('rotate');
    expect(second.total.updatedRows).toBe(0);
    expect(second.total.updatedValues).toBe(0);
    expect(database.audits).toHaveLength(3);
  });

  it('keeps a partially completed run readable and resumes safely', async () => {
    const { database, dualKey, newOnly } = fixture();
    const rotation = service(database, dualKey);
    database.failEntityOnce = 'TelegramCallbackReference';

    await expect(rotation.execute('rotate')).rejects.toThrow(
      'Synthetic interruption'
    );
    for (const value of encryptedValues(database)) {
      expect(() => dualKey.decrypt(value)).not.toThrow();
    }
    expect(newOnly.keySource(database.stores[0]!.consumerKeyEncrypted)).toBe(
      'current'
    );
    expect(database.audits).toHaveLength(1);

    const recovered = await rotation.execute('rotate');
    expect(recovered.status).toBe('complete');
    expect(recovered.total.updatedRows).toBe(2);
    expect(recovered.total.updatedValues).toBe(2);
    expect(database.audits).toHaveLength(3);
  });

  it('fails preflight without writing when any ciphertext is unreadable', async () => {
    const { database, dualKey } = fixture();
    database.callbacks[0]!.noteBodyEncrypted = 'invalid-ciphertext';

    const report = await service(database, dualKey).execute('rotate');
    expect(report.status).toBe('failed');
    expect(report.passed).toBe(false);
    expect(report.total.unreadable).toBe(1);
    expect(report.total.updatedRows).toBe(0);
    expect(database.audits).toHaveLength(0);
  });
});
