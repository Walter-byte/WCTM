import {
  Prisma,
  PrismaClient,
  StoreStatus,
  TelegramInventoryNotificationState,
  TelegramOrderNotificationState,
  TenantEntitlementStatus,
} from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export interface TenantPrivacyTarget {
  tenantId: string;
  nameSha256: string;
}

export interface IdentityPrivacyTarget {
  tenantId: string;
  userId: string;
  emailSha256: string;
}

export function privacyFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function anonymousTelegramId(): bigint {
  return -(randomBytes(8).readBigUInt64BE() & ((1n << 62n) - 1n)) - 1n;
}

export class PilotAccountService {
  constructor(private readonly database: PrismaClient) {}

  async resolveTenant(target: TenantPrivacyTarget) {
    const tenants = await this.database.tenant.findMany({
      where: { id: target.tenantId },
      select: { id: true, name: true, deletedAt: true },
      take: 2,
    });
    if (
      tenants.length !== 1 ||
      privacyFingerprint(tenants[0]!.name) !== target.nameSha256
    ) {
      throw new Error(
        'privacy Tenant identity is missing, erased or ambiguous'
      );
    }
    return tenants[0]!;
  }

  async resolveIdentity(target: IdentityPrivacyTarget) {
    const memberships = await this.database.membership.findMany({
      where: { tenantId: target.tenantId, userId: target.userId },
      select: {
        id: true,
        deletedAt: true,
        user: { select: { email: true } },
      },
      take: 2,
    });
    if (
      memberships.length !== 1 ||
      privacyFingerprint(memberships[0]!.user.email) !== target.emailSha256
    ) {
      throw new Error('privacy User identity is missing, erased or ambiguous');
    }
    return memberships[0]!;
  }

  async inspectTenant(target: TenantPrivacyTarget) {
    await this.resolveTenant(target);
    const [stores, memberships] = await Promise.all([
      this.database.store.findMany({
        where: { tenantId: target.tenantId },
        select: { id: true, status: true, deletedAt: true, baseUrl: true },
        orderBy: { id: 'asc' },
      }),
      this.database.membership.findMany({
        where: { tenantId: target.tenantId },
        select: { userId: true, deletedAt: true },
        orderBy: { id: 'asc' },
      }),
    ]);
    return {
      tenantId: target.tenantId,
      stores: stores.map((store) => ({
        id: store.id,
        erased: isErasedStore(store),
      })),
      users: await Promise.all(
        memberships.map(async (membership) => ({
          id: membership.userId,
          membershipErased: await this.identityErasureComplete({
            tenantId: target.tenantId,
            userId: membership.userId,
          }),
          shared:
            (await this.otherMemberships(
              this.database,
              target.tenantId,
              membership.userId
            )) > 0,
        }))
      ),
      retained: [
        'referential identifiers',
        'security audit until retention',
        'historical backups',
      ],
    };
  }

  async exportTenant(target: TenantPrivacyTarget) {
    await this.resolveTenant(target);
    const [tenant, stores, memberships, audit] = await Promise.all([
      this.database.tenant.findUniqueOrThrow({
        where: { id: target.tenantId },
        select: {
          id: true,
          name: true,
          plan: true,
          timezone: true,
          language: true,
          createdAt: true,
        },
      }),
      this.database.store.findMany({
        where: { tenantId: target.tenantId },
        select: { id: true, name: true, baseUrl: true, status: true },
        orderBy: { id: 'asc' },
      }),
      this.database.membership.findMany({
        where: { tenantId: target.tenantId },
        select: {
          id: true,
          role: true,
          deletedAt: true,
          user: {
            select: {
              id: true,
              email: true,
              displayName: true,
              telegramAccount: {
                select: { id: true, telegramUserId: true, deletedAt: true },
              },
            },
          },
        },
        orderBy: { id: 'asc' },
      }),
      this.database.auditLog.findMany({
        where: { tenantId: target.tenantId },
        select: {
          id: true,
          userId: true,
          action: true,
          entityType: true,
          entityId: true,
          metadata: true,
          createdAt: true,
        },
        orderBy: { id: 'asc' },
      }),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      tenant,
      stores,
      memberships,
      audit,
    };
  }

  async inspectIdentity(target: IdentityPrivacyTarget) {
    await this.resolveIdentity(target);
    return {
      tenantId: target.tenantId,
      userId: target.userId,
      shared:
        (await this.otherMemberships(
          this.database,
          target.tenantId,
          target.userId
        )) > 0,
      retained: [
        'referential identifiers',
        'security audit until retention',
        'historical backups',
      ],
    };
  }

  async exportIdentity(target: IdentityPrivacyTarget) {
    await this.resolveIdentity(target);
    const [membership, audit] = await Promise.all([
      this.database.membership.findFirstOrThrow({
        where: { tenantId: target.tenantId, userId: target.userId },
        select: {
          id: true,
          tenantId: true,
          role: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              email: true,
              displayName: true,
              telegramAccount: {
                select: {
                  id: true,
                  telegramUserId: true,
                  deletedAt: true,
                  chatAuthorizations: {
                    where: { activeTenantId: target.tenantId },
                    select: { telegramChatId: true, activeStoreId: true },
                  },
                },
              },
            },
          },
        },
      }),
      this.database.auditLog.findMany({
        where: { tenantId: target.tenantId, userId: target.userId },
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          metadata: true,
          createdAt: true,
        },
        orderBy: { id: 'asc' },
      }),
    ]);
    return { exportedAt: new Date().toISOString(), membership, audit };
  }

  async eraseIdentity(target: IdentityPrivacyTarget) {
    await this.resolveIdentity(target);
    return this.database.$transaction(
      async (tx) =>
        this.eraseIdentityInTransaction(
          tx,
          target.tenantId,
          target.userId,
          new Date(),
          target.emailSha256
        ),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  async eraseTenant(target: TenantPrivacyTarget) {
    await this.resolveTenant(target);
    return this.database.$transaction(
      async (tx) => {
        const tenant = await tx.tenant.findUniqueOrThrow({
          where: { id: target.tenantId },
          select: { name: true, deletedAt: true },
        });
        if (privacyFingerprint(tenant.name) !== target.nameSha256)
          throw new Error('privacy Tenant identity changed before erasure');
        const stores = await tx.store.findMany({
          where: { tenantId: target.tenantId },
          select: { id: true, baseUrl: true, status: true, deletedAt: true },
        });
        if (stores.some((store) => !isErasedStore(store))) {
          throw new Error(
            'erase each linked Store and archive its ledger entry first'
          );
        }
        const members = await tx.membership.findMany({
          where: { tenantId: target.tenantId },
          select: { userId: true },
        });
        const now = new Date();
        const identities = [];
        for (const member of members) {
          if (
            await this.identityErasureComplete(
              { tenantId: target.tenantId, userId: member.userId },
              tx
            )
          )
            continue;
          identities.push(
            await this.eraseIdentityInTransaction(
              tx,
              target.tenantId,
              member.userId,
              now
            )
          );
        }
        await tx.telegramChatAuthorization.updateMany({
          where: { activeTenantId: target.tenantId },
          data: { activeTenantId: null, activeStoreId: null, revokedAt: now },
        });
        const changed = await tx.tenant.updateMany({
          where: {
            id: target.tenantId,
            name: tenant.name,
            deletedAt: tenant.deletedAt,
          },
          data: {
            name: `Erased tenant ${target.tenantId}`,
            deletedAt: now,
            entitlementStatus: TenantEntitlementStatus.SUSPENDED,
          },
        });
        if (changed.count !== 1)
          throw new Error('privacy Tenant changed during erasure');
        await tx.auditLog.create({
          data: {
            id: `aud_${randomUUID()}`,
            tenantId: target.tenantId,
            userId: null,
            action: 'privacy.tenant_erased',
            entityType: 'Tenant',
            entityId: target.tenantId,
            metadata: {
              erasedAt: now.toISOString(),
              nameSha256: target.nameSha256,
              retained: 'security-audit-and-referential-ids',
            },
          },
        });
        return {
          users: identities.length,
          sharedUsersRetained: identities.filter((entry) => entry.shared)
            .length,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  // Soft deletion revokes access; only a matching privacy transaction proves erasure.
  // If retention has removed the audit proof, replay must verify the original
  // fingerprint and erase again, or fail closed on an anonymized mismatch.
  async identityErasureComplete(
    target: { tenantId: string; userId: string; emailSha256?: string },
    tx: Prisma.TransactionClient | PrismaClient = this.database
  ): Promise<boolean> {
    const membership = await tx.membership.findFirst({
      where: { tenantId: target.tenantId, userId: target.userId },
      select: {
        id: true,
        deletedAt: true,
        user: {
          select: {
            email: true,
            displayName: true,
            passwordHash: true,
            telegramAccount: {
              select: {
                id: true,
                telegramUserId: true,
                deletedAt: true,
                lastRedeemUpdateId: true,
                lastUnlinkUpdateId: true,
                chatAuthorizations: {
                  select: {
                    telegramChatId: true,
                    activeTenantId: true,
                    activeStoreId: true,
                    revokedAt: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!membership?.deletedAt) return false;
    const shared =
      (await this.otherMemberships(tx, target.tenantId, target.userId)) > 0;
    const user = membership.user;
    const account = user.telegramAccount;
    if (shared) {
      if (
        target.emailSha256 &&
        privacyFingerprint(user.email) !== target.emailSha256
      )
        return false;
      if (
        account?.chatAuthorizations.some(
          (chat) => chat.activeTenantId === target.tenantId
        )
      )
        return false;
    } else {
      if (
        user.email !== `erased-${target.userId}@invalid.invalid` ||
        user.displayName !== null ||
        user.passwordHash !== null
      )
        return false;
      if (
        account &&
        (!account.deletedAt ||
          account.telegramUserId >= 0n ||
          account.lastRedeemUpdateId !== null ||
          account.lastUnlinkUpdateId !== null ||
          account.chatAuthorizations.some(
            (chat) =>
              chat.telegramChatId >= 0n ||
              chat.activeTenantId !== null ||
              chat.activeStoreId !== null ||
              !chat.revokedAt
          ))
      )
        return false;
      if (
        await tx.telegramLinkToken.count({ where: { userId: target.userId } })
      )
        return false;
    }
    const audit = await tx.auditLog.findFirst({
      where: {
        tenantId: target.tenantId,
        userId: target.userId,
        action: 'privacy.identity_erased',
        entityType: 'User',
        entityId: target.userId,
        AND: [
          {
            metadata: {
              path: ['erasedAt'],
              equals: membership.deletedAt.toISOString(),
            },
          },
          { metadata: { path: ['sharedIdentityRetained'], equals: shared } },
          ...(target.emailSha256
            ? [
                {
                  metadata: {
                    path: ['emailSha256'],
                    equals: target.emailSha256,
                  },
                },
              ]
            : []),
        ],
      },
      select: { id: true },
    });
    if (!audit) return false;
    const remaining = [
      await tx.storeNotificationRecipient.count({
        where: { tenantId: target.tenantId, membershipId: membership.id },
      }),
      await tx.telegramSettingsReference.count({
        where: {
          tenantId: target.tenantId,
          targetMembershipId: membership.id,
          expiresAt: { gt: membership.deletedAt },
        },
      }),
    ];
    if (account) {
      const scoped = {
        tenantId: target.tenantId,
        telegramAccountId: account.id,
      };
      const referencePii = [
        { telegramChatId: { gte: 0n } },
        { expiresAt: { gt: membership.deletedAt } },
      ];
      remaining.push(
        ...(await Promise.all([
          tx.telegramSettingsReference.count({
            where: { ...scoped, OR: referencePii },
          }),
          tx.telegramCallbackReference.count({
            where: {
              ...scoped,
              OR: [
                ...referencePii,
                { noteBodyEncrypted: { not: null } },
                { noteContentFingerprint: { not: null } },
              ],
            },
          }),
          tx.telegramInventoryReference.count({
            where: { ...scoped, OR: referencePii },
          }),
          tx.telegramSearchReference.count({
            where: {
              ...scoped,
              OR: [...referencePii, { queryEncrypted: { not: null } }],
            },
          }),
          tx.telegramOrderNoteAction.count({
            where: {
              ...scoped,
              OR: [
                { contentFingerprint: { not: '0'.repeat(64) } },
                { result: { not: Prisma.AnyNull } },
              ],
            },
          }),
          tx.telegramOrderStatusWrite.count({
            where: { ...scoped, result: { not: Prisma.AnyNull } },
          }),
          tx.telegramOrderNotificationDelivery.count({
            where: {
              ...scoped,
              OR: [
                { telegramMessageId: { not: null } },
                {
                  state: {
                    in: [
                      TelegramOrderNotificationState.PENDING,
                      TelegramOrderNotificationState.IN_FLIGHT,
                      TelegramOrderNotificationState.RETRYABLE_FAILURE,
                    ],
                  },
                },
              ],
            },
          }),
          tx.telegramInventoryNotificationDelivery.count({
            where: {
              ...scoped,
              OR: [
                { telegramMessageId: { not: null } },
                {
                  state: {
                    in: [
                      TelegramInventoryNotificationState.PENDING,
                      TelegramInventoryNotificationState.IN_FLIGHT,
                      TelegramInventoryNotificationState.RETRYABLE_FAILURE,
                    ],
                  },
                },
              ],
            },
          }),
        ]))
      );
    }
    return remaining.every((count) => count === 0);
  }

  async tenantErasureComplete(target: TenantPrivacyTarget): Promise<boolean> {
    const tenant = await this.database.tenant.findUnique({
      where: { id: target.tenantId },
      select: { name: true, deletedAt: true, entitlementStatus: true },
    });
    if (
      !tenant?.deletedAt ||
      tenant.name !== `Erased tenant ${target.tenantId}` ||
      tenant.entitlementStatus !== TenantEntitlementStatus.SUSPENDED
    )
      return false;
    const audit = await this.database.auditLog.findFirst({
      where: {
        tenantId: target.tenantId,
        userId: null,
        action: 'privacy.tenant_erased',
        entityType: 'Tenant',
        entityId: target.tenantId,
        AND: [
          {
            metadata: {
              path: ['erasedAt'],
              equals: tenant.deletedAt.toISOString(),
            },
          },
          { metadata: { path: ['nameSha256'], equals: target.nameSha256 } },
        ],
      },
      select: { id: true },
    });
    if (!audit) return false;
    const stores = await this.database.store.findMany({
      where: { tenantId: target.tenantId },
      select: { id: true, baseUrl: true, status: true, deletedAt: true },
    });
    if (stores.some((store) => !isErasedStore(store))) return false;
    const members = await this.database.membership.findMany({
      where: { tenantId: target.tenantId },
      select: { userId: true },
    });
    for (const member of members) {
      if (
        !(await this.identityErasureComplete({
          tenantId: target.tenantId,
          userId: member.userId,
        }))
      )
        return false;
    }
    return (
      (await this.database.telegramChatAuthorization.count({
        where: { activeTenantId: target.tenantId },
      })) === 0
    );
  }

  private async otherMemberships(
    tx: Prisma.TransactionClient | PrismaClient,
    tenantId: string,
    userId: string
  ) {
    return tx.membership.count({
      where: {
        userId,
        tenantId: { not: tenantId },
      },
    });
  }

  private async eraseIdentityInTransaction(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    now: Date,
    emailSha256?: string
  ) {
    const membership = await tx.membership.findFirst({
      where: { tenantId, userId },
      select: { id: true, deletedAt: true, user: { select: { email: true } } },
    });
    if (
      !membership ||
      (emailSha256 && privacyFingerprint(membership.user.email) !== emailSha256)
    )
      throw new Error('privacy User identity changed before erasure');
    const shared = (await this.otherMemberships(tx, tenantId, userId)) > 0;
    const account = await tx.telegramAccount.findUnique({
      where: { userId },
      select: { id: true, deletedAt: true },
    });
    await tx.storeNotificationRecipient.deleteMany({
      where: { tenantId, membershipId: membership.id },
    });
    await tx.telegramSettingsReference.updateMany({
      where: { tenantId, targetMembershipId: membership.id },
      data: { expiresAt: now },
    });
    if (account) {
      const scoped = { tenantId, telegramAccountId: account.id };
      await tx.telegramSettingsReference.updateMany({
        where: scoped,
        data: { expiresAt: now, telegramChatId: anonymousTelegramId() },
      });
      await tx.telegramCallbackReference.updateMany({
        where: scoped,
        data: {
          expiresAt: now,
          telegramChatId: anonymousTelegramId(),
          noteBodyEncrypted: null,
          noteContentFingerprint: null,
        },
      });
      await tx.telegramInventoryReference.updateMany({
        where: scoped,
        data: { expiresAt: now, telegramChatId: anonymousTelegramId() },
      });
      await tx.telegramSearchReference.updateMany({
        where: scoped,
        data: {
          expiresAt: now,
          telegramChatId: anonymousTelegramId(),
          queryEncrypted: null,
        },
      });
      await tx.telegramOrderNoteAction.updateMany({
        where: scoped,
        data: { contentFingerprint: '0'.repeat(64), result: Prisma.DbNull },
      });
      await tx.telegramOrderStatusWrite.updateMany({
        where: scoped,
        data: { result: Prisma.DbNull },
      });
      // Both delivery tables preserve FK and state evidence while removing message IDs.
      await tx.telegramOrderNotificationDelivery.updateMany({
        where: scoped,
        data: { telegramMessageId: null },
      });
      await tx.telegramInventoryNotificationDelivery.updateMany({
        where: scoped,
        data: { telegramMessageId: null },
      });
      await tx.telegramOrderNotificationDelivery.updateMany({
        where: {
          ...scoped,
          state: {
            in: [
              TelegramOrderNotificationState.PENDING,
              TelegramOrderNotificationState.IN_FLIGHT,
              TelegramOrderNotificationState.RETRYABLE_FAILURE,
            ],
          },
        },
        data: {
          state: TelegramOrderNotificationState.TERMINAL_FAILURE,
          failureCategory: 'privacy',
          failureCode: 'identity-erased',
        },
      });
      await tx.telegramInventoryNotificationDelivery.updateMany({
        where: {
          ...scoped,
          state: {
            in: [
              TelegramInventoryNotificationState.PENDING,
              TelegramInventoryNotificationState.IN_FLIGHT,
              TelegramInventoryNotificationState.RETRYABLE_FAILURE,
            ],
          },
        },
        data: {
          state: TelegramInventoryNotificationState.TERMINAL_FAILURE,
          failureCategory: 'privacy',
          failureCode: 'identity-erased',
        },
      });
      await tx.telegramChatAuthorization.updateMany({
        where: { telegramAccountId: account.id, activeTenantId: tenantId },
        data: { activeTenantId: null, activeStoreId: null, revokedAt: now },
      });
    }
    const changed = await tx.membership.updateMany({
      where: {
        id: membership.id,
        tenantId,
        userId,
        deletedAt: membership.deletedAt,
      },
      data: { deletedAt: now },
    });
    if (changed.count !== 1)
      throw new Error('privacy Membership changed during erasure');
    if (!shared) {
      await tx.telegramLinkToken.deleteMany({ where: { userId } });
      const userChanged = await tx.user.updateMany({
        where: { id: userId, email: membership.user.email },
        data: {
          email: `erased-${userId}@invalid.invalid`,
          displayName: null,
          passwordHash: null,
        },
      });
      if (userChanged.count !== 1)
        throw new Error('privacy User changed during erasure');
      if (account) {
        const chats = await tx.telegramChatAuthorization.findMany({
          where: { telegramAccountId: account.id },
          select: { id: true },
        });
        for (const chat of chats) {
          await tx.telegramChatAuthorization.update({
            where: { id: chat.id },
            data: {
              telegramChatId: anonymousTelegramId(),
              activeTenantId: null,
              activeStoreId: null,
              revokedAt: now,
            },
          });
        }
        const accountChanged = await tx.telegramAccount.updateMany({
          where: { id: account.id, userId },
          data: {
            telegramUserId: anonymousTelegramId(),
            lastRedeemUpdateId: null,
            lastUnlinkUpdateId: null,
            deletedAt: now,
          },
        });
        if (accountChanged.count !== 1)
          throw new Error('privacy Telegram identity changed during erasure');
      }
    }
    await tx.auditLog.create({
      data: {
        id: `aud_${randomUUID()}`,
        tenantId,
        userId,
        action: 'privacy.identity_erased',
        entityType: 'User',
        entityId: userId,
        metadata: {
          erasedAt: now.toISOString(),
          emailSha256: privacyFingerprint(membership.user.email),
          sharedIdentityRetained: shared,
          retained: 'security-audit-and-referential-ids',
        },
      },
    });
    return { userId, shared };
  }
}

function isErasedStore(store: {
  id: string;
  baseUrl: string;
  status: StoreStatus;
  deletedAt: Date | null;
}): boolean {
  return (
    store.status === StoreStatus.DISCONNECTED &&
    store.deletedAt !== null &&
    store.baseUrl === `https://erased.invalid/${store.id}`
  );
}
