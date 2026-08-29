import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, StoreStatus, TelegramChatType } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { JwtPayload } from '../auth/auth.service';
import { ApplicationConfigService } from '../config/application-config.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  TelegramRedeemDto,
  TelegramStatusDto,
  TelegramUnlinkDto,
} from './dto/telegram-internal.dto';

const INVALID_TOKEN_RESULT = { status: 'invalid_or_expired' } as const;

export interface TelegramLinkTokenResult {
  token: string;
  expiresAt: Date;
}

export interface TelegramAuthorizationStatus {
  linked: boolean;
  authorized: boolean;
  membershipState: 'active' | 'none';
  activeTenantId: string | null;
  activeStoreId: string | null;
  tenantSelectionRequired: boolean;
  storeSelectionRequired: boolean;
  selectionRequired: boolean;
}

export type TelegramRedeemResult =
  | typeof INVALID_TOKEN_RESULT
  | ({ status: 'linked' } & TelegramAuthorizationStatus);

export type TelegramUnlinkResult =
  | { status: 'confirmation_required' }
  | { status: 'unauthorized' }
  | { status: 'unlinked' };

@Injectable()
export class TelegramLinkingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configuration: ApplicationConfigService
  ) {}

  async issueToken(
    payload: JwtPayload | undefined
  ): Promise<TelegramLinkTokenResult> {
    const userId = this.authenticatedUserId(payload);
    await this.assertLinkingEligible(userId);
    const token = `tgl_${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(
      Date.now() + this.configuration.telegram.linkTokenTtlSeconds * 1000
    );

    try {
      await this.prisma.telegramLinkToken.create({
        data: {
          id: `tlt_${randomUUID()}`,
          userId,
          tokenHash: this.hash(token),
          expiresAt,
        },
        select: { id: true },
      });
    } catch (error) {
      if (this.isMissingUser(error)) {
        throw new UnauthorizedException('Authenticated user was not found');
      }

      throw error;
    }

    return { token, expiresAt };
  }

  async redeem(input: TelegramRedeemDto): Promise<TelegramRedeemResult> {
    const tokenHash = this.hash(input.token);

    try {
      return await this.prisma.$transaction(
        (transaction) =>
          this.redeemInTransaction(transaction, input, tokenHash),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (error) {
      if (this.isExpectedLinkConflict(error)) {
        return INVALID_TOKEN_RESULT;
      }

      throw error;
    }
  }

  async status(input: TelegramStatusDto): Promise<TelegramAuthorizationStatus> {
    const telegramUserId = BigInt(input.telegramUserId);
    const telegramChatId = BigInt(input.telegramChatId);
    const account = await this.prisma.telegramAccount.findUnique({
      where: { telegramUserId },
      select: {
        id: true,
        userId: true,
        deletedAt: true,
        chatAuthorizations: {
          where: { telegramChatId },
          select: {
            telegramAccountId: true,
            revokedAt: true,
          },
        },
      },
    });

    if (
      !account ||
      account.deletedAt ||
      account.chatAuthorizations.length !== 1 ||
      account.chatAuthorizations[0]?.telegramAccountId !== account.id ||
      account.chatAuthorizations[0]?.revokedAt
    ) {
      return this.unauthorizedStatus();
    }

    return this.resolveContext(this.prisma, account.userId);
  }

  async unlink(input: TelegramUnlinkDto): Promise<TelegramUnlinkResult> {
    if (!input.confirmed) {
      return { status: 'confirmation_required' };
    }

    const telegramUserId = BigInt(input.telegramUserId);
    const telegramChatId = BigInt(input.telegramChatId);
    const updateId = BigInt(input.updateId);

    return this.prisma.$transaction(
      async (transaction) => {
        const account = await transaction.telegramAccount.findUnique({
          where: { telegramUserId },
          select: {
            id: true,
            deletedAt: true,
            lastUnlinkUpdateId: true,
            chatAuthorizations: {
              where: { telegramChatId },
              select: { telegramAccountId: true },
            },
          },
        });

        const identityMatches =
          account?.chatAuthorizations.length === 1 &&
          account.chatAuthorizations[0]?.telegramAccountId === account.id;

        if (
          account?.lastUnlinkUpdateId === updateId &&
          account.deletedAt !== null &&
          identityMatches
        ) {
          return { status: 'unlinked' };
        }

        if (!account || account.deletedAt || !identityMatches) {
          return { status: 'unauthorized' };
        }

        const revokedAt = new Date();
        await transaction.telegramChatAuthorization.updateMany({
          where: {
            telegramAccountId: account.id,
            revokedAt: null,
          },
          data: { revokedAt, activeTenantId: null, activeStoreId: null },
        });
        await transaction.telegramAccount.update({
          where: { id: account.id },
          data: { deletedAt: revokedAt, lastUnlinkUpdateId: updateId },
          select: { id: true },
        });

        return { status: 'unlinked' };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  private async redeemInTransaction(
    transaction: Prisma.TransactionClient,
    input: TelegramRedeemDto,
    tokenHash: string
  ): Promise<TelegramRedeemResult> {
    const now = new Date();
    const telegramUserId = BigInt(input.telegramUserId);
    const telegramChatId = BigInt(input.telegramChatId);
    const updateId = BigInt(input.updateId);
    const token = await transaction.telegramLinkToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        consumedAt: true,
      },
    });

    if (!token) {
      return INVALID_TOKEN_RESULT;
    }

    const accountSelection = {
      id: true,
      userId: true,
      telegramUserId: true,
      deletedAt: true,
      lastRedeemUpdateId: true,
    } satisfies Prisma.TelegramAccountSelect;
    const [accountByTelegramUser, accountBySaasUser] = await Promise.all([
      transaction.telegramAccount.findUnique({
        where: { telegramUserId },
        select: accountSelection,
      }),
      transaction.telegramAccount.findUnique({
        where: { userId: token.userId },
        select: accountSelection,
      }),
    ]);
    const conflictingAccounts =
      accountByTelegramUser &&
      accountBySaasUser &&
      accountByTelegramUser.id !== accountBySaasUser.id;
    const telegramIdentityConflict =
      accountByTelegramUser !== null &&
      accountByTelegramUser.userId !== token.userId;
    const saasIdentityConflict =
      accountBySaasUser !== null &&
      accountBySaasUser.telegramUserId !== telegramUserId;

    if (
      conflictingAccounts ||
      telegramIdentityConflict ||
      saasIdentityConflict
    ) {
      return INVALID_TOKEN_RESULT;
    }

    const existingAccount = accountBySaasUser ?? accountByTelegramUser;

    if (
      token.consumedAt &&
      existingAccount?.telegramUserId === telegramUserId &&
      existingAccount.userId === token.userId &&
      existingAccount.lastRedeemUpdateId === updateId &&
      !existingAccount.deletedAt
    ) {
      const authorization =
        await transaction.telegramChatAuthorization.findUnique({
          where: { telegramChatId },
          select: { telegramAccountId: true, revokedAt: true },
        });

      if (
        authorization?.telegramAccountId === existingAccount.id &&
        !authorization.revokedAt
      ) {
        return {
          status: 'linked',
          ...(await this.resolveContext(transaction, token.userId)),
        };
      }
    }

    if (token.consumedAt || token.expiresAt <= now) {
      return INVALID_TOKEN_RESULT;
    }

    const existingChat = await transaction.telegramChatAuthorization.findUnique(
      {
        where: { telegramChatId },
        select: { telegramAccountId: true },
      }
    );

    if (
      existingChat &&
      existingChat.telegramAccountId !== existingAccount?.id
    ) {
      return INVALID_TOKEN_RESULT;
    }

    const consumed = await transaction.telegramLinkToken.updateMany({
      where: {
        id: token.id,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });

    if (consumed.count !== 1) {
      return INVALID_TOKEN_RESULT;
    }

    const account = existingAccount
      ? await transaction.telegramAccount.update({
          where: { id: existingAccount.id },
          data: {
            telegramUserId,
            deletedAt: null,
            lastRedeemUpdateId: updateId,
          },
          select: { id: true },
        })
      : await transaction.telegramAccount.create({
          data: {
            id: `tga_${randomUUID()}`,
            telegramUserId,
            userId: token.userId,
            lastRedeemUpdateId: updateId,
          },
          select: { id: true },
        });
    const context = await this.resolveContext(transaction, token.userId);

    if (existingChat) {
      await transaction.telegramChatAuthorization.update({
        where: { telegramChatId },
        data: {
          chatType: TelegramChatType.PRIVATE,
          revokedAt: null,
          activeTenantId: context.activeTenantId,
          activeStoreId: context.activeStoreId,
        },
        select: { id: true },
      });
    } else {
      await transaction.telegramChatAuthorization.create({
        data: {
          id: `tgc_${randomUUID()}`,
          telegramAccountId: account.id,
          telegramChatId,
          chatType: TelegramChatType.PRIVATE,
          activeTenantId: context.activeTenantId,
          activeStoreId: context.activeStoreId,
        },
        select: { id: true },
      });
    }

    return { status: 'linked', ...context };
  }

  private async resolveContext(
    transaction: Prisma.TransactionClient | PrismaService,
    userId: string
  ): Promise<TelegramAuthorizationStatus> {
    const memberships = await transaction.membership.findMany({
      where: {
        userId,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: { tenantId: true },
      take: 2,
    });
    const hasOneTenant = memberships.length === 1;
    const activeTenantId = hasOneTenant ? memberships[0]!.tenantId : null;
    const stores = activeTenantId
      ? await transaction.store.findMany({
          where: {
            tenantId: activeTenantId,
            status: StoreStatus.ACTIVE,
            deletedAt: null,
            tenant: { deletedAt: null },
          },
          select: {
            id: true,
            lastHealthyAt: true,
            webhookSecretEncrypted: true,
            webhookEndpointKey: true,
          },
          take: 2,
        })
      : [];
    const hasOneStore =
      stores.length === 1 &&
      stores[0]!.lastHealthyAt !== null &&
      stores[0]!.webhookSecretEncrypted !== null &&
      stores[0]!.webhookEndpointKey !== null;
    const contextResolved = hasOneTenant && hasOneStore;
    const tenantSelectionRequired = memberships.length !== 1;
    const storeSelectionRequired = hasOneTenant && stores.length !== 1;

    return {
      linked: true,
      authorized: memberships.length > 0,
      membershipState: memberships.length > 0 ? 'active' : 'none',
      activeTenantId: contextResolved ? activeTenantId : null,
      activeStoreId: contextResolved ? stores[0]!.id : null,
      tenantSelectionRequired,
      storeSelectionRequired,
      selectionRequired: tenantSelectionRequired || storeSelectionRequired,
    };
  }

  private async assertLinkingEligible(userId: string): Promise<void> {
    const memberships = await this.prisma.membership.findMany({
      where: {
        userId,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: { tenantId: true },
      take: 2,
    });

    if (memberships.length !== 1) {
      throw new ForbiddenException(
        'Exactly one active Tenant membership is required for Telegram linking'
      );
    }

    const stores = await this.prisma.store.findMany({
      where: {
        tenantId: memberships[0]!.tenantId,
        status: StoreStatus.ACTIVE,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: {
        id: true,
        lastHealthyAt: true,
        webhookSecretEncrypted: true,
        webhookEndpointKey: true,
      },
      take: 2,
    });

    if (
      stores.length !== 1 ||
      stores[0]!.lastHealthyAt === null ||
      stores[0]!.webhookSecretEncrypted === null ||
      stores[0]!.webhookEndpointKey === null
    ) {
      throw new ForbiddenException(
        'Exactly one ACTIVE and healthy Store is required for Telegram linking'
      );
    }
  }

  private unauthorizedStatus(): TelegramAuthorizationStatus {
    return {
      linked: false,
      authorized: false,
      membershipState: 'none',
      activeTenantId: null,
      activeStoreId: null,
      tenantSelectionRequired: false,
      storeSelectionRequired: false,
      selectionRequired: false,
    };
  }

  private authenticatedUserId(payload: JwtPayload | undefined): string {
    const userId = payload?.sub;

    if (typeof userId !== 'string' || userId.trim() === '') {
      throw new UnauthorizedException('Authenticated user subject is required');
    }

    return userId;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private isMissingUser(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2003'
    );
  }

  private isExpectedLinkConflict(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return false;
    }

    if (error.code === 'P2002') {
      return true;
    }

    if (error.code === 'P2034') {
      throw new ServiceUnavailableException(
        'Telegram linking is temporarily unavailable'
      );
    }

    return false;
  }
}
