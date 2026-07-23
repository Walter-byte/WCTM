import { Bot, InlineKeyboard, type Context } from 'grammy';

import { InternalBackendClient } from './internal-backend.client';
import { UpdateDeduplicator } from './update-deduplicator';

const PRIVATE_ONLY_MESSAGE =
  'This bot can only be used in a private Telegram chat.';
const TRANSIENT_FAILURE_MESSAGE =
  'The service is temporarily unavailable. Please try again.';
const INVALID_TOKEN_MESSAGE =
  'This link token is invalid or expired. Request a new token and try again.';

export interface BotAdapterDependencies {
  backend: InternalBackendClient;
  deduplicator?: UpdateDeduplicator;
  log?: (record: Readonly<Record<string, unknown>>) => void;
}

export function createBot(
  token: string,
  dependencies: BotAdapterDependencies
): Bot {
  const bot = new Bot(token);
  const deduplicator = dependencies.deduplicator ?? new UpdateDeduplicator();
  const log = dependencies.log ?? (() => undefined);

  bot.use(async (context, next) => {
    if (!deduplicator.accept(context.update.update_id)) {
      return;
    }

    log({
      event: 'telegram_update_received',
      correlationId: `telegram-update-${context.update.update_id.toString()}`,
      telegramUpdateId: context.update.update_id.toString(),
    });

    if (context.chat && context.chat.type !== 'private') {
      await context.reply(PRIVATE_ONLY_MESSAGE);
      return;
    }

    await next();
  });

  bot.command('start', async (context) => {
    const identity = privateIdentity(context);

    if (!identity) {
      return;
    }

    const tokenArgument = context.match.trim();

    try {
      if (tokenArgument) {
        const result = await dependencies.backend.redeem(
          identity,
          tokenArgument
        );

        await context.reply(
          result.status === 'invalid_or_expired'
            ? INVALID_TOKEN_MESSAGE
            : renderStatus(result)
        );
        return;
      }

      await context.reply(
        renderStatus(await dependencies.backend.status(identity))
      );
    } catch {
      await context.reply(TRANSIENT_FAILURE_MESSAGE);
    }
  });

  bot.command('status', async (context) => {
    const identity = privateIdentity(context);

    if (!identity) {
      return;
    }

    try {
      await context.reply(
        renderStatus(await dependencies.backend.status(identity))
      );
    } catch {
      await context.reply(TRANSIENT_FAILURE_MESSAGE);
    }
  });

  bot.command('unlink', async (context) => {
    if (!privateIdentity(context)) {
      return;
    }

    await context.reply(
      'Unlink this Telegram account? You will need a new token to link again.',
      {
        reply_markup: new InlineKeyboard().text(
          'Confirm unlink',
          'unlink:confirm'
        ),
      }
    );
  });

  bot.callbackQuery('unlink:confirm', async (context) => {
    const identity = privateIdentity(context);

    if (!identity) {
      await context.answerCallbackQuery();
      return;
    }

    try {
      const result = await dependencies.backend.unlink(identity, true);

      await context.answerCallbackQuery();
      await context.editMessageReplyMarkup();
      await context.reply(
        result.status === 'unlinked'
          ? 'Your Telegram account has been unlinked.'
          : 'This chat is not authorized.'
      );
    } catch {
      await context.answerCallbackQuery();
      await context.reply(TRANSIENT_FAILURE_MESSAGE);
    }
  });

  return bot;
}

function privateIdentity(context: Context):
  | {
      telegramUserId: string;
      telegramChatId: string;
      updateId: string;
    }
  | undefined {
  if (!context.from || !context.chat || context.chat.type !== 'private') {
    return undefined;
  }

  return {
    telegramUserId: context.from.id.toString(),
    telegramChatId: context.chat.id.toString(),
    updateId: context.update.update_id.toString(),
  };
}

export function renderStatus(status: {
  linked: boolean;
  authorized: boolean;
  selectionRequired: boolean;
  activeTenantId: string | null;
  activeStoreId: string | null;
}): string {
  if (!status.linked) {
    return 'This Telegram account is not linked. Use /start <token> to link it.';
  }

  if (!status.authorized) {
    return 'Your Telegram account is linked, but no active tenant membership is available.';
  }

  if (status.selectionRequired) {
    return 'Your Telegram account is linked. Tenant or store selection is required in a later setup step.';
  }

  if (status.activeTenantId && status.activeStoreId) {
    return 'Your Telegram account is linked and authorized.';
  }

  return 'Your Telegram account is linked, but no active store context is available.';
}

export const BOT_MESSAGES = {
  privateOnly: PRIVATE_ONLY_MESSAGE,
  transientFailure: TRANSIENT_FAILURE_MESSAGE,
  invalidToken: INVALID_TOKEN_MESSAGE,
} as const;
