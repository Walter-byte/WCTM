import { describe, expect, it, jest } from '@jest/globals';
import { PrismaClient, StoreStatus } from '@prisma/client';

import {
  PilotAccountService,
  privacyFingerprint,
} from './pilot-account.service';

const tenantTarget = {
  tenantId: 'ten_a',
  nameSha256: privacyFingerprint('Pilot shop'),
};
const identityTarget = {
  tenantId: 'ten_a',
  userId: 'usr_a',
  emailSha256: privacyFingerprint('owner@example.test'),
};
const now = new Date();

function fixture(shared = false) {
  const update = jest.fn(async () => ({ count: 1 }));
  const create = jest.fn(async () => ({ id: 'aud_fixture' }));
  const tx = {
    tenant: {
      findUniqueOrThrow: jest.fn(async () => ({
        name: 'Pilot shop',
        deletedAt: null,
      })),
      updateMany: update,
    },
    store: {
      findMany: jest.fn(async () => [
        {
          id: 'sto_a',
          baseUrl: 'https://erased.invalid/sto_a',
          status: StoreStatus.DISCONNECTED,
          deletedAt: now,
        },
      ]),
    },
    membership: {
      findMany: jest.fn(async () => [{ userId: 'usr_a' }]),
      findFirst: jest.fn(async () => ({
        id: 'mem_a',
        user: { email: 'owner@example.test' },
      })),
      count: jest.fn(async () => (shared ? 1 : 0)),
      updateMany: update,
    },
    user: { updateMany: jest.fn(async () => ({ count: 1 })) },
    telegramAccount: {
      findUnique: jest.fn(async () => ({
        id: 'tga_a',
        deletedAt: null as Date | null,
      })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    telegramChatAuthorization: {
      updateMany: update,
      findMany: jest.fn(async () => [{ id: 'chat_a' }]),
      update: jest.fn(async () => ({ id: 'chat_a' })),
    },
    telegramLinkToken: { deleteMany: jest.fn(async () => ({ count: 1 })) },
    storeNotificationRecipient: { deleteMany: update },
    telegramSettingsReference: { updateMany: update },
    telegramCallbackReference: { updateMany: update },
    telegramInventoryReference: { updateMany: update },
    telegramSearchReference: { updateMany: update },
    telegramOrderNoteAction: { updateMany: update },
    telegramOrderStatusWrite: { updateMany: update },
    telegramOrderNotificationDelivery: { updateMany: update },
    telegramInventoryNotificationDelivery: { updateMany: update },
    auditLog: { create },
  };
  const database = {
    tenant: {
      findMany: jest.fn(async () => [
        {
          id: 'ten_a',
          name: 'Pilot shop',
          deletedAt: null,
        },
      ]),
      findUniqueOrThrow: jest.fn(async () => ({
        id: 'ten_a',
        name: 'Pilot shop',
      })),
    },
    membership: {
      findMany: jest.fn(async () => [
        {
          id: 'mem_a',
          deletedAt: null,
          tenant: { deletedAt: null },
          user: { email: 'owner@example.test' },
        },
      ]),
      count: jest.fn(async () => (shared ? 1 : 0)),
      findFirstOrThrow: jest.fn(async () => ({
        id: 'mem_a',
        tenantId: 'ten_a',
        user: { id: 'usr_a', email: 'owner@example.test' },
      })),
    },
    store: { findMany: tx.store.findMany },
    auditLog: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)
    ),
  };
  return {
    service: new PilotAccountService(database as unknown as PrismaClient),
    database,
    tx,
  };
}

describe('operator Tenant/User identity lifecycle', () => {
  it('fails closed on an inexact Tenant or User fingerprint', async () => {
    const test = fixture();
    await expect(
      test.service.inspectTenant({
        ...tenantTarget,
        nameSha256: '0'.repeat(64),
      })
    ).rejects.toThrow('identity');
    await expect(
      test.service.inspectIdentity({
        ...identityTarget,
        emailSha256: '0'.repeat(64),
      })
    ).rejects.toThrow('identity');
    expect(test.database.$transaction).not.toHaveBeenCalled();
  });

  it('refuses Tenant erasure until every linked Store has been erased', async () => {
    const test = fixture();
    test.tx.store.findMany.mockResolvedValueOnce([
      {
        id: 'sto_a',
        baseUrl: 'https://shop.example.test',
        status: StoreStatus.ACTIVE,
        deletedAt: null,
      },
    ] as never);
    await expect(test.service.eraseTenant(tenantTarget)).rejects.toThrow(
      'linked Store'
    );
    expect(test.tx.tenant.updateMany).not.toHaveBeenCalled();
  });

  it('retains a shared User/Telegram identity while removing only target-Tenant access', async () => {
    const test = fixture(true);
    await expect(test.service.eraseIdentity(identityTarget)).resolves.toEqual({
      userId: 'usr_a',
      shared: true,
    });
    expect(test.tx.membership.count).toHaveBeenCalledWith({
      where: { userId: 'usr_a', tenantId: { not: 'ten_a' } },
    });
    expect(test.tx.membership.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'ten_a',
          userId: 'usr_a',
        }),
      })
    );
    expect(
      test.tx.telegramOrderNotificationDelivery.updateMany
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'ten_a',
          telegramAccountId: 'tga_a',
        }),
      })
    );
    expect(test.tx.user.updateMany).not.toHaveBeenCalled();
    expect(test.tx.telegramAccount.updateMany).not.toHaveBeenCalled();
    expect(test.tx.telegramLinkToken.deleteMany).not.toHaveBeenCalled();
  });

  it('anonymizes an exclusive User and Telegram identity without breaking FKs', async () => {
    const test = fixture();
    await test.service.eraseIdentity(identityTarget);
    expect(test.tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'usr_a', email: 'owner@example.test' },
      data: {
        email: 'erased-usr_a@invalid.invalid',
        displayName: null,
        passwordHash: null,
      },
    });
    expect(test.tx.telegramAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tga_a', userId: 'usr_a' },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      })
    );
    expect(test.tx.telegramChatAuthorization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'chat_a' },
        data: expect.objectContaining({
          activeTenantId: null,
          activeStoreId: null,
        }),
      })
    );
    expect(test.tx.telegramLinkToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'usr_a' },
    });
  });

  it('anonymizes an already unlinked Telegram identity for an exclusive User', async () => {
    const test = fixture();
    test.tx.telegramAccount.findUnique.mockResolvedValueOnce({
      id: 'tga_a',
      deletedAt: now,
    });
    await test.service.eraseIdentity(identityTarget);
    expect(test.tx.telegramAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tga_a', userId: 'usr_a' },
        data: expect.objectContaining({
          telegramUserId: expect.anything(),
          deletedAt: expect.any(Date),
        }),
      })
    );
  });

  it('erases a prepared Tenant after linked Store erasure and records bounded exceptions', async () => {
    const test = fixture();
    await expect(test.service.eraseTenant(tenantTarget)).resolves.toEqual({
      users: 1,
      sharedUsersRetained: 0,
    });
    expect(test.tx.tenant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ten_a', name: 'Pilot shop', deletedAt: null },
        data: expect.objectContaining({ name: 'Erased tenant ten_a' }),
      })
    );
    expect(test.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'ten_a',
          action: 'privacy.tenant_erased',
        }),
      })
    );
  });

  it('exports only the targeted Tenant or User audit scope', async () => {
    const test = fixture();
    await test.service.exportTenant(tenantTarget);
    expect(test.database.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 'ten_a' } })
    );
    await test.service.exportIdentity(identityTarget);
    expect(test.database.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'ten_a',
          userId: 'usr_a',
        },
      })
    );
  });
});
