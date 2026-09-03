import { describe, expect, it, jest } from '@jest/globals';
import { TenantLanguage } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_TELEGRAM_PRESENTATION,
  TelegramPresentationService,
} from './telegram-presentation.service';

describe('TelegramPresentationService', () => {
  it('defaults unlinked and pre-Tenant Telegram UX to Persian', async () => {
    const { service, accountFindUnique, membershipFindFirst } = setup({
      account: null,
    });

    await expect(
      service.resolve({ telegramUserId: '1001', telegramChatId: '2001' })
    ).resolves.toEqual(DEFAULT_TELEGRAM_PRESENTATION);
    expect(accountFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { telegramUserId: 1001n } })
    );
    expect(membershipFindFirst).not.toHaveBeenCalled();
  });

  it.each<{
    tenantLanguage: TenantLanguage;
    expected: 'fa' | 'en';
  }>([
    { tenantLanguage: TenantLanguage.FA, expected: 'fa' },
    { tenantLanguage: TenantLanguage.EN, expected: 'en' },
  ])(
    'uses the selected active Tenant $tenantLanguage language and timezone',
    async ({ tenantLanguage, expected }) => {
      const { service, membershipFindFirst } = setup({
        tenant: { language: tenantLanguage, timezone: 'Asia/Tehran' },
      });

      await expect(
        service.resolve({ telegramUserId: '1001', telegramChatId: '2001' })
      ).resolves.toEqual({ language: expected, timezone: 'Asia/Tehran' });
      expect(membershipFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'usr_a',
            tenantId: 'ten_selected',
          }),
        })
      );
    }
  );

  it('falls back safely for unknown runtime language and invalid timezone', async () => {
    const { service } = setup({
      tenant: {
        language: 'UNKNOWN' as TenantLanguage,
        timezone: 'Not/A-Timezone',
      },
    });

    await expect(
      service.resolve({ telegramUserId: '1001', telegramChatId: '2001' })
    ).resolves.toEqual({ language: 'en', timezone: 'UTC' });
  });

  it('does not accept any Telegram client language input', () => {
    expect(TelegramPresentationService.prototype.resolve.length).toBe(1);
  });
});

function setup(
  overrides: {
    account?: {
      userId: string;
      deletedAt: Date | null;
      chatAuthorizations: Array<{ activeTenantId: string | null }>;
    } | null;
    tenant?: { language: TenantLanguage; timezone: string };
  } = {}
) {
  const accountFindUnique = jest.fn(async () =>
    overrides.account === undefined
      ? {
          userId: 'usr_a',
          deletedAt: null,
          chatAuthorizations: [{ activeTenantId: 'ten_selected' }],
        }
      : overrides.account
  );
  const membershipFindFirst = jest.fn(async () => ({
    tenant: overrides.tenant ?? {
      language: TenantLanguage.EN,
      timezone: 'UTC',
    },
  }));
  const prisma = {
    telegramAccount: { findUnique: accountFindUnique },
    membership: { findFirst: membershipFindFirst },
  } as unknown as PrismaService;

  return {
    service: new TelegramPresentationService(prisma),
    accountFindUnique,
    membershipFindFirst,
  };
}
