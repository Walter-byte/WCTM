import { Injectable } from '@nestjs/common';
import { TenantLanguage } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

export type TelegramPresentationLanguage = 'fa' | 'en';

export interface TelegramPresentation {
  language: TelegramPresentationLanguage;
  timezone: string;
}

export type TelegramPresented<T> = T & {
  presentation: TelegramPresentation;
};

export const DEFAULT_TELEGRAM_PRESENTATION: TelegramPresentation = {
  language: 'fa',
  timezone: 'UTC',
};

@Injectable()
export class TelegramPresentationService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(identity: {
    telegramUserId: string;
    telegramChatId: string;
  }): Promise<TelegramPresentation> {
    const telegramUserId = BigInt(identity.telegramUserId);
    const telegramChatId = BigInt(identity.telegramChatId);
    const account = await this.prisma.telegramAccount.findUnique({
      where: { telegramUserId },
      select: {
        userId: true,
        deletedAt: true,
        chatAuthorizations: {
          where: { telegramChatId, revokedAt: null },
          select: { activeTenantId: true },
          take: 1,
        },
      },
    });

    if (
      !account ||
      account.deletedAt ||
      account.chatAuthorizations.length !== 1 ||
      !account.chatAuthorizations[0]!.activeTenantId
    ) {
      return DEFAULT_TELEGRAM_PRESENTATION;
    }

    const membership = await this.prisma.membership.findFirst({
      where: {
        userId: account.userId,
        tenantId: account.chatAuthorizations[0]!.activeTenantId,
        deletedAt: null,
        tenant: { deletedAt: null },
      },
      select: {
        tenant: { select: { language: true, timezone: true } },
      },
    });

    if (!membership) {
      return DEFAULT_TELEGRAM_PRESENTATION;
    }

    const tenant = membership.tenant;

    return {
      language:
        tenant.language === TenantLanguage.FA
          ? 'fa'
          : tenant.language === TenantLanguage.EN
            ? 'en'
            : 'en',
      timezone: validTimezone(tenant.timezone) ? tenant.timezone : 'UTC',
    };
  }

  async present<T>(
    identity: { telegramUserId: string; telegramChatId: string },
    result: T
  ): Promise<TelegramPresented<T>> {
    return {
      ...result,
      presentation: await this.resolve(identity),
    };
  }
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}
