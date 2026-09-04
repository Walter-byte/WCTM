import { Bot, InlineKeyboard, type Context } from 'grammy';

import { InternalBackendClient } from './internal-backend.client';
import type {
  OrderDetailPayload,
  OrderDetailResult,
  OrderListResult,
  OrderLookupResult,
  OrderNoteMutationResult,
  OrderNoteOptionsResult,
  OrderNotePrepareResult,
  OrderNoteStartResult,
  OrderNoteVisibility,
  OrderRefreshResult,
  OrderStatusUpdateResult,
  OrderSummary,
  OrderTransitionsResult,
  SettingsInputStartResult,
  SettingsResult,
  SettingsSummary,
  StockDetailResult,
  StockListResult,
  DailyReportResult,
  SearchResult,
  SearchSelectionResult,
  TelegramAuthorizationStatus,
  TelegramIdentity,
  EntitlementSummary,
} from './internal-backend.client';
import { UpdateDeduplicator } from './update-deduplicator';
import {
  commandMenu,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  inventoryLabel,
  isolateLtr,
  languageOf,
  statusLabel,
  timezoneOf,
  translate,
  type TelegramLanguage,
} from './localization';

const NAVIGATION_CALLBACKS = {
  home: 'nav:home',
  orders: 'nav:orders',
  status: 'nav:status',
  help: 'nav:help',
  settings: 'nav:settings',
  stock: 'nav:stock',
  search: 'nav:search',
  report: 'nav:report',
} as const;

export const BOT_COMMANDS = commandMenu('fa');

interface RenderedView {
  text: string;
  keyboard: InlineKeyboard;
}

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
      await context.reply(translate('fa', 'general.privateOnly'));
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
        const rendered =
          result.status === 'invalid_or_expired'
            ? renderRecoveryView(
                translate(languageOf(result, 'fa'), 'general.invalidToken'),
                'help',
                languageOf(result, 'fa')
              )
            : result.status === 'entitlement_inactive'
              ? renderEntitlementInactive(result)
              : renderLanding(
                  result,
                  translate(languageOf(result), 'home.linked')
                );

        await configureChatCommandMenu(context, languageOf(result), log);
        await replyView(context, rendered);
        return;
      }

      const result = await dependencies.backend.status(identity);
      await configureChatCommandMenu(context, languageOf(result, 'fa'), log);
      await replyView(context, renderLanding(result));
    } catch (error: unknown) {
      logTransportFailure(log, identity.updateId, error);
      await replyView(context, renderTransportFailure(error, 'status', 'fa'));
    }
  });

  bot.command('status', async (context) => {
    const identity = privateIdentity(context);

    if (!identity) {
      return;
    }

    try {
      await replyView(
        context,
        renderStatusView(await dependencies.backend.status(identity))
      );
    } catch (error: unknown) {
      logTransportFailure(log, identity.updateId, error);
      await replyView(context, renderTransportFailure(error, 'status', 'fa'));
    }
  });

  bot.command('help', async (context) => {
    const identity = privateIdentity(context);
    if (!identity) {
      return;
    }
    if (typeof dependencies.backend.status !== 'function') {
      await replyView(context, renderHelp());
      return;
    }

    try {
      const status = await dependencies.backend.status(identity);
      await replyView(context, renderHelp(languageOf(status, 'fa')));
    } catch (error: unknown) {
      logTransportFailure(log, identity.updateId, error);
      await replyView(context, renderTransportFailure(error, 'help', 'fa'));
    }
  });

  bot.command('settings', async (context) => {
    const identity = privateIdentity(context);

    if (!identity) {
      return;
    }

    try {
      await replyView(
        context,
        renderSettings(await dependencies.backend.settings(identity))
      );
    } catch (error: unknown) {
      logTransportFailure(log, identity.updateId, error);
      await replyView(context, renderTransportFailure(error, 'settings', 'fa'));
    }
  });

  bot.command('unlink', async (context) => {
    const identity = privateIdentity(context);
    if (!identity) {
      return;
    }
    try {
      const status = await dependencies.backend.status(identity);
      const language = languageOf(status, 'fa');
      await replyView(context, {
        text: translate(language, 'unlink.confirm'),
        keyboard: new InlineKeyboard()
          .text(translate(language, 'action.confirmUnlink'), 'unlink:confirm')
          .row()
          .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home),
      });
    } catch (error: unknown) {
      logTransportFailure(log, identity.updateId, error);
      await replyView(context, renderTransportFailure(error, 'status', 'fa'));
    }
  });

  bot.command('orders', async (context) => {
    const identity = privateIdentity(context);

    if (!identity) {
      return;
    }

    try {
      const result = await dependencies.backend.listOrders(identity);
      await replyView(context, renderOrderList(result));
    } catch (error: unknown) {
      logTransportFailure(log, identity.updateId, error);
      await replyView(context, renderTransportFailure(error, 'orders', 'fa'));
    }
  });

  bot.command('stock', async (context) => {
    const identity = privateIdentity(context);

    if (!identity) {
      return;
    }

    try {
      await replyView(
        context,
        renderStockList(await dependencies.backend.listStock(identity))
      );
    } catch (error: unknown) {
      logTransportFailure(log, identity.updateId, error);
      await replyView(context, renderTransportFailure(error, 'stock', 'fa'));
    }
  });

  bot.command('search', async (context) => {
    const identity = privateIdentity(context);

    if (!identity) {
      return;
    }

    try {
      await replyView(
        context,
        renderSearch(
          await dependencies.backend.search(identity, {
            query: context.match.trim(),
          })
        )
      );
    } catch (error: unknown) {
      logTransportFailure(log, identity.updateId, error);
      await replyView(context, renderTransportFailure(error, 'search', 'fa'));
    }
  });

  bot.command('report', async (context) => {
    const identity = privateIdentity(context);

    if (!identity) {
      return;
    }

    try {
      await replyView(
        context,
        renderDailyReport(await dependencies.backend.report(identity))
      );
    } catch (error: unknown) {
      logTransportFailure(log, identity.updateId, error);
      await replyView(context, renderTransportFailure(error, 'report', 'fa'));
    }
  });

  bot.command('order', async (context) => {
    const identity = privateIdentity(context);

    if (!identity) {
      return;
    }

    try {
      const result = await dependencies.backend.lookupOrder(
        identity,
        context.match.trim()
      );
      await replyView(context, renderOrderLookup(result));
    } catch (error: unknown) {
      logTransportFailure(log, identity.updateId, error);
      await replyView(context, renderTransportFailure(error, 'orders', 'fa'));
    }
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
      await replyView(
        context,
        result.status === 'unlinked'
          ? renderRecoveryView(
              translate(languageOf(result, 'fa'), 'unlink.success'),
              'help',
              languageOf(result, 'fa')
            )
          : renderRecoveryView(
              translate(languageOf(result, 'fa'), 'unlink.unauthorized'),
              'status',
              languageOf(result, 'fa')
            )
      );
    } catch (error: unknown) {
      logTransportFailure(log, identity.updateId, error);
      await safeAnswerCallback(context);
      await replyView(context, renderTransportFailure(error, 'status', 'fa'));
    }
  });

  bot.callbackQuery(NAVIGATION_CALLBACKS.home, async (context) => {
    await handleViewCallback(
      context,
      async (identity) =>
        renderLanding(await dependencies.backend.status(identity)),
      log
    );
  });

  bot.callbackQuery(NAVIGATION_CALLBACKS.orders, async (context) => {
    await handleViewCallback(
      context,
      async (identity) =>
        renderOrderList(await dependencies.backend.listOrders(identity)),
      log,
      'orders'
    );
  });

  bot.callbackQuery(NAVIGATION_CALLBACKS.status, async (context) => {
    await handleViewCallback(
      context,
      async (identity) =>
        renderStatusView(await dependencies.backend.status(identity)),
      log,
      'status'
    );
  });

  bot.callbackQuery(NAVIGATION_CALLBACKS.help, async (context) => {
    await handleViewCallback(
      context,
      async (identity) => {
        if (typeof dependencies.backend.status !== 'function') {
          return renderHelp();
        }
        const status = await dependencies.backend.status(identity);
        return renderHelp(languageOf(status, 'fa'));
      },
      log
    );
  });

  bot.callbackQuery(NAVIGATION_CALLBACKS.settings, async (context) => {
    await handleViewCallback(
      context,
      async (identity) =>
        renderSettings(await dependencies.backend.settings(identity)),
      log,
      'settings'
    );
  });

  bot.callbackQuery(NAVIGATION_CALLBACKS.stock, async (context) => {
    await handleViewCallback(
      context,
      async (identity) =>
        renderStockList(await dependencies.backend.listStock(identity)),
      log,
      'stock'
    );
  });

  bot.callbackQuery(NAVIGATION_CALLBACKS.search, async (context) => {
    await handleViewCallback(
      context,
      async (identity) => {
        if (typeof dependencies.backend.status !== 'function') {
          return renderSearchUsage();
        }
        const status = await dependencies.backend.status(identity);
        return renderSearchUsage(languageOf(status, 'fa'));
      },
      log
    );
  });

  bot.callbackQuery(NAVIGATION_CALLBACKS.report, async (context) => {
    await handleViewCallback(
      context,
      async (identity) =>
        renderDailyReport(await dependencies.backend.report(identity)),
      log,
      'report'
    );
  });

  bot.callbackQuery(
    /^q\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/,
    async (context) => {
      const identity = privateIdentity(context);

      if (!identity) {
        await safeAnswerCallback(context);
        return;
      }

      try {
        const rendered = renderSearch(
          await dependencies.backend.search(identity, {
            cursor: context.callbackQuery.data,
          })
        );
        await safeAnswerCallback(context);
        await editOrReply(context, rendered.text, rendered.keyboard);
      } catch (error: unknown) {
        logTransportFailure(log, identity.updateId, error);
        await safeAnswerCallback(context);
        const rendered = renderTransportFailure(error, 'search');
        await editOrReply(context, rendered.text, rendered.keyboard);
      }
    }
  );

  bot.callbackQuery(
    /^u\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/,
    async (context) => {
      const identity = privateIdentity(context);

      if (!identity) {
        await safeAnswerCallback(context);
        return;
      }

      try {
        const rendered = renderSearchSelection(
          await dependencies.backend.selectSearchResult(
            identity,
            context.callbackQuery.data
          )
        );
        await safeAnswerCallback(context);
        await editOrReply(context, rendered.text, rendered.keyboard);
      } catch (error: unknown) {
        logTransportFailure(log, identity.updateId, error);
        await safeAnswerCallback(context);
        const rendered = renderTransportFailure(error, 'search');
        await editOrReply(context, rendered.text, rendered.keyboard);
      }
    }
  );

  bot.callbackQuery(
    /^sg:g\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/,
    async (context) => {
      const identity = privateIdentity(context);

      if (!identity) {
        await safeAnswerCallback(context);
        return;
      }

      try {
        const result = await dependencies.backend.applySettingsAction(
          identity,
          context.callbackQuery.data.slice(3)
        );
        await configureChatCommandMenu(context, languageOf(result), log);
        const rendered = renderSettings(result);
        await safeAnswerCallback(context);
        await editOrReply(context, rendered.text, rendered.keyboard);
      } catch (error: unknown) {
        logTransportFailure(log, identity.updateId, error);
        await safeAnswerCallback(context);
        const rendered = renderTransportFailure(error, 'settings');
        await editOrReply(context, rendered.text, rendered.keyboard);
      }
    }
  );

  bot.callbackQuery(
    /^si:g\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/,
    async (context) => {
      const identity = privateIdentity(context);

      if (!identity) {
        await safeAnswerCallback(context);
        return;
      }

      try {
        const result = await dependencies.backend.startSettingsInput(
          identity,
          context.callbackQuery.data.slice(3)
        );
        const rendered = renderSettingsInputStart(result);
        await safeAnswerCallback(context);
        await editOrReply(context, rendered.text, rendered.keyboard);

        if (result.state === 'OK' && result.inputRef && result.purpose) {
          const language = languageOf(result);
          await context.reply(
            [
              result.purpose === 'TIMEZONE'
                ? translate(language, 'settings.timezonePrompt', {
                    value: isolateLtr('Asia/Tehran'),
                  })
                : translate(language, 'settings.thresholdPrompt'),
              '',
              `${translate(language, 'settings.reference')} ${result.inputRef}`,
            ].join('\n'),
            {
              reply_markup: {
                force_reply: true,
                selective: true,
                input_field_placeholder:
                  result.purpose === 'TIMEZONE'
                    ? 'Asia/Tehran'
                    : translate(language, 'settings.thresholdPlaceholder'),
              },
            }
          );
        }
      } catch (error: unknown) {
        logTransportFailure(log, identity.updateId, error);
        await safeAnswerCallback(context);
        const rendered = renderTransportFailure(error, 'settings');
        await editOrReply(context, rendered.text, rendered.keyboard);
      }
    }
  );

  bot.callbackQuery(
    /^p\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/,
    async (context) => {
      const identity = privateIdentity(context);

      if (!identity) {
        await safeAnswerCallback(context);
        return;
      }

      try {
        const result = await dependencies.backend.listOrders(
          identity,
          context.callbackQuery.data
        );
        const rendered = renderOrderList(result);

        await safeAnswerCallback(context);
        await editOrReply(context, rendered.text, rendered.keyboard);
      } catch (error: unknown) {
        logTransportFailure(log, identity.updateId, error);
        await safeAnswerCallback(context);
        const rendered = renderTransportFailure(error, 'orders');
        await editOrReply(context, rendered.text, rendered.keyboard);
      }
    }
  );

  bot.callbackQuery(
    /^d\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/,
    async (context) => {
      const identity = privateIdentity(context);

      if (!identity) {
        await safeAnswerCallback(context);
        return;
      }

      try {
        const result = await dependencies.backend.orderDetail(
          identity,
          context.callbackQuery.data
        );
        const rendered = renderOrderDetail(result);

        await safeAnswerCallback(context);
        await editOrReply(context, rendered.text, rendered.keyboard);
      } catch (error: unknown) {
        logTransportFailure(log, identity.updateId, error);
        await safeAnswerCallback(context);
        const rendered = renderTransportFailure(error, 'orders');
        await editOrReply(context, rendered.text, rendered.keyboard);
      }
    }
  );

  bot.callbackQuery(
    /^k\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/,
    async (context) => {
      const identity = privateIdentity(context);

      if (!identity) {
        await safeAnswerCallback(context);
        return;
      }

      try {
        const rendered = renderStockList(
          await dependencies.backend.listStock(
            identity,
            context.callbackQuery.data
          )
        );
        await safeAnswerCallback(context);
        await editOrReply(context, rendered.text, rendered.keyboard);
      } catch (error: unknown) {
        logTransportFailure(log, identity.updateId, error);
        await safeAnswerCallback(context);
        const rendered = renderTransportFailure(error, 'stock');
        await editOrReply(context, rendered.text, rendered.keyboard);
      }
    }
  );

  bot.callbackQuery(
    /^v\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/,
    async (context) => {
      const identity = privateIdentity(context);

      if (!identity) {
        await safeAnswerCallback(context);
        return;
      }

      try {
        const rendered = renderStockDetail(
          await dependencies.backend.stockDetail(
            identity,
            context.callbackQuery.data
          )
        );
        await safeAnswerCallback(context);
        await editOrReply(context, rendered.text, rendered.keyboard);
      } catch (error: unknown) {
        logTransportFailure(log, identity.updateId, error);
        await safeAnswerCallback(context);
        const rendered = renderTransportFailure(error, 'stock');
        await editOrReply(context, rendered.text, rendered.keyboard);
      }
    }
  );

  bot.callbackQuery(
    /^r:d\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/,
    async (context) => {
      const identity = privateIdentity(context);

      if (!identity) {
        await safeAnswerCallback(context);
        return;
      }

      try {
        const result = await dependencies.backend.refreshOrder(
          identity,
          context.callbackQuery.data.slice(2)
        );
        const rendered = renderOrderRefresh(result);

        await safeAnswerCallback(context);
        await editOrReply(context, rendered.text, rendered.keyboard);
      } catch (error: unknown) {
        logTransportFailure(log, identity.updateId, error);
        await safeAnswerCallback(context);
        const rendered = renderTransportFailure(error, 'orders');
        await editOrReply(context, rendered.text, rendered.keyboard);
      }
    }
  );

  bot.callbackQuery(
    /^n:d\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/,
    async (context) => {
      const identity = privateIdentity(context);

      if (!identity) {
        await safeAnswerCallback(context);
        return;
      }

      try {
        const detailRef = context.callbackQuery.data.slice(2);
        const result = await dependencies.backend.orderNoteOptions(
          identity,
          detailRef
        );
        const rendered = renderOrderNoteOptions(result, detailRef);

        await safeAnswerCallback(context);
        await editOrReply(context, rendered.text, rendered.keyboard);
      } catch (error: unknown) {
        logTransportFailure(log, identity.updateId, error);
        await safeAnswerCallback(context);
        const rendered = renderTransportFailure(error, 'orders');
        await editOrReply(context, rendered.text, rendered.keyboard);
      }
    }
  );

  bot.callbackQuery(
    /^v:d\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}:(?:INTERNAL|CUSTOMER)$/,
    async (context) => {
      const identity = privateIdentity(context);

      if (!identity) {
        await safeAnswerCallback(context);
        return;
      }

      const separator = context.callbackQuery.data.lastIndexOf(':');
      const detailRef = context.callbackQuery.data.slice(2, separator);
      const visibility = context.callbackQuery.data.slice(
        separator + 1
      ) as OrderNoteVisibility;

      try {
        const result = await dependencies.backend.startOrderNote(
          identity,
          detailRef,
          visibility
        );
        const rendered = renderOrderNoteStart(result);

        await safeAnswerCallback(context);
        await editOrReply(context, rendered.text, rendered.keyboard);

        if (result.state === 'OK' && result.inputRef && result.maxLength) {
          const language = languageOf(result);
          await context.reply(
            [
              translate(language, 'notes.prompt', {
                value: formatNumber(result.maxLength, language),
              }),
              '',
              `${translate(language, 'notes.reference')} ${result.inputRef}`,
            ].join('\n'),
            {
              reply_markup: {
                force_reply: true,
                selective: true,
                input_field_placeholder: translate(
                  language,
                  'notes.placeholder'
                ),
              },
            }
          );
        }
      } catch (error: unknown) {
        logTransportFailure(log, identity.updateId, error);
        await safeAnswerCallback(context);
        const rendered = renderTransportFailure(error, 'orders');
        await editOrReply(context, rendered.text, rendered.keyboard);
      }
    }
  );

  bot.callbackQuery(
    /^nc:c\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/,
    async (context) => {
      const identity = privateIdentity(context);

      if (!identity) {
        await safeAnswerCallback(context);
        return;
      }

      try {
        const result = await dependencies.backend.confirmOrderNote(
          identity,
          context.callbackQuery.data.slice(3)
        );
        const rendered = renderOrderNoteMutation(result);

        await safeAnswerCallback(context);
        await editOrReply(context, rendered.text, rendered.keyboard);
      } catch (error: unknown) {
        logTransportFailure(log, identity.updateId, error);
        await safeAnswerCallback(context);
        const rendered = renderTransportFailure(error, 'orders');
        await editOrReply(context, rendered.text, rendered.keyboard);
      }
    }
  );

  bot.callbackQuery(
    /^x:[ic]\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/,
    async (context) => {
      const identity = privateIdentity(context);

      if (!identity) {
        await safeAnswerCallback(context);
        return;
      }

      try {
        const result = await dependencies.backend.cancelOrderNote(
          identity,
          context.callbackQuery.data.slice(2)
        );
        const rendered = renderOrderNoteMutation(result);

        await safeAnswerCallback(context);
        await editOrReply(context, rendered.text, rendered.keyboard);
      } catch (error: unknown) {
        logTransportFailure(log, identity.updateId, error);
        await safeAnswerCallback(context);
        const rendered = renderTransportFailure(error, 'orders');
        await editOrReply(context, rendered.text, rendered.keyboard);
      }
    }
  );

  bot.callbackQuery(
    /^t:d\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/,
    async (context) => {
      const identity = privateIdentity(context);

      if (!identity) {
        await safeAnswerCallback(context);
        return;
      }

      try {
        const detailRef = context.callbackQuery.data.slice(2);
        const result = await dependencies.backend.orderTransitions(
          identity,
          detailRef
        );
        const rendered = renderOrderTransitions(result, detailRef);

        await safeAnswerCallback(context);
        await editOrReply(context, rendered.text, rendered.keyboard);
      } catch (error: unknown) {
        logTransportFailure(log, identity.updateId, error);
        await safeAnswerCallback(context);
        const rendered = renderTransportFailure(error, 'orders');
        await editOrReply(context, rendered.text, rendered.keyboard);
      }
    }
  );

  bot.callbackQuery(
    /^s\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}:[a-z0-9-]{1,25}$/,
    async (context) => {
      const identity = privateIdentity(context);

      if (!identity) {
        await safeAnswerCallback(context);
        return;
      }

      const separator = context.callbackQuery.data.lastIndexOf(':');
      const ref = context.callbackQuery.data.slice(0, separator);
      const target = context.callbackQuery.data.slice(separator + 1);

      try {
        const result = await dependencies.backend.updateOrderStatus(
          identity,
          ref,
          target
        );
        const rendered = renderOrderStatusUpdate(result);

        await safeAnswerCallback(context);
        await editOrReply(context, rendered.text, rendered.keyboard);
      } catch (error: unknown) {
        logTransportFailure(log, identity.updateId, error);
        await safeAnswerCallback(context);
        const rendered = renderTransportFailure(error, 'orders');
        await editOrReply(context, rendered.text, rendered.keyboard);
      }
    }
  );

  bot.on('message:text', async (context) => {
    const identity = privateIdentity(context);
    const replyText =
      context.message.reply_to_message &&
      'text' in context.message.reply_to_message
        ? context.message.reply_to_message.text
        : undefined;
    const inputRef = noteInputReference(replyText);
    const settingsRef = settingsInputReference(replyText);

    if (!identity || (!inputRef && !settingsRef)) {
      return;
    }

    try {
      if (settingsRef) {
        const result = await dependencies.backend.applySettingsInput(
          identity,
          settingsRef,
          context.message.text
        );
        await replyView(context, renderSettings(result));
        return;
      }

      const result = await dependencies.backend.prepareOrderNote(
        identity,
        inputRef!,
        context.message.text
      );
      await replyView(context, renderOrderNotePrepare(result, inputRef!));
    } catch (error: unknown) {
      logTransportFailure(log, identity.updateId, error);
      await replyView(
        context,
        renderTransportFailure(error, settingsRef ? 'settings' : 'orders')
      );
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

function renderLanding(
  status: TelegramAuthorizationStatus,
  notice?: string
): RenderedView {
  const language = languageOf(status);
  if (!isReadyStatus(status)) {
    const statusView = renderStatusView(status);

    return {
      text: notice ? `${notice}\n\n${statusView.text}` : statusView.text,
      keyboard: statusView.keyboard,
    };
  }

  return {
    text: [
      notice,
      translate(language, 'home.title'),
      '',
      translate(language, 'home.choose'),
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n'),
    keyboard: homeKeyboard(language),
  };
}

function renderStatusView(status: TelegramAuthorizationStatus): RenderedView {
  const language = languageOf(status);
  const keyboard = new InlineKeyboard();

  if (isReadyStatus(status)) {
    keyboard
      .text(translate(language, 'nav.orders'), NAVIGATION_CALLBACKS.orders)
      .row();
  } else {
    keyboard
      .text(translate(language, 'nav.settings'), NAVIGATION_CALLBACKS.settings)
      .row()
      .text(translate(language, 'nav.help'), NAVIGATION_CALLBACKS.help)
      .row();
  }

  keyboard.text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home);

  return {
    text: [translate(language, 'status.title'), '', renderStatus(status)].join(
      '\n'
    ),
    keyboard,
  };
}

function renderHelp(language: TelegramLanguage = 'en'): RenderedView {
  return {
    text: [
      translate(language, 'help.title'),
      '',
      translate(language, 'help.body'),
      '',
      translate(language, 'help.secureActions'),
    ].join('\n'),
    keyboard: new InlineKeyboard()
      .text(translate(language, 'nav.orders'), NAVIGATION_CALLBACKS.orders)
      .text(translate(language, 'nav.stock'), NAVIGATION_CALLBACKS.stock)
      .row()
      .text(translate(language, 'nav.search'), NAVIGATION_CALLBACKS.search)
      .text(translate(language, 'nav.report'), NAVIGATION_CALLBACKS.report)
      .row()
      .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home),
  };
}

export function renderSettings(result: SettingsResult): RenderedView {
  const language = languageOf(result);
  if (result.state === 'ENTITLEMENT_INACTIVE') {
    return renderEntitlementInactive(result);
  }
  if (result.state !== 'OK' || !result.settings) {
    return renderRecoveryView(
      settingsStateMessage(result.state, language),
      result.state === 'UNAUTHORIZED' || result.state === 'NO_ACTIVE_STORE'
        ? 'status'
        : 'settings',
      language
    );
  }

  const settings = result.settings;
  const entitlement = settings.entitlement ?? {
    plan: 'FREE' as const,
    status: 'ACTIVE' as const,
    effectiveState: 'ACTIVE' as const,
    expiresAt: null,
  };
  const inactive = entitlement.effectiveState !== 'ACTIVE';
  const categories = settings.enabledNotificationCategories.map((category) =>
    notificationCategoryLabel(category, language)
  );
  const recipients = settings.recipients
    .filter((recipient) => recipient.selected)
    .map(
      (recipient) =>
        `• ${recipient.displayName}${recipient.availability === 'UNAVAILABLE' ? translate(language, 'settings.unavailableSuffix') : ''}`
    );
  const keyboard = new InlineKeyboard();

  if (settings.editable && settings.actions) {
    for (const language of settings.actions.languages) {
      keyboard.text(
        `${settings.language === language.language ? '✓ ' : ''}${translate(
          languageOf(result),
          language.language === 'FA' ? 'label.fa' : 'label.en'
        )}`,
        `sg:${language.ref}`
      );
    }

    keyboard
      .row()
      .text(
        translate(language, 'action.setTimezone'),
        `si:${settings.actions.timezoneInputRef}`
      )
      .row()
      .text(
        translate(language, 'action.setThreshold'),
        `si:${settings.actions.thresholdInputRef}`
      )
      .text(
        translate(language, 'action.clearThreshold'),
        `sg:${settings.actions.thresholdClearRef}`
      );

    for (const category of settings.actions.categories) {
      keyboard
        .row()
        .text(
          translate(
            language,
            category.enabled ? 'action.disable' : 'action.enable',
            { value: notificationCategoryLabel(category.category, language) }
          ),
          `sg:${category.enabled ? category.disableRef : category.enableRef}`
        );
    }

    for (const mode of settings.actions.recipientModes) {
      keyboard
        .row()
        .text(
          `${settings.recipientMode === mode.mode ? '✓ ' : ''}${recipientModeLabel(mode.mode, language)}`,
          `sg:${mode.ref}`
        );
    }

    for (const recipient of settings.recipients) {
      if (!recipient.actionRef || !recipient.action) {
        continue;
      }

      const actionKey =
        recipient.action === 'SELECT' ? 'action.select' : 'action.remove';
      const availability =
        recipient.availability === 'UNAVAILABLE'
          ? translate(language, 'settings.unavailableSuffix')
          : '';
      const label = translate(language, actionKey, {
        value: `${recipient.displayName}${availability}`,
      });
      keyboard
        .row()
        .text(
          label.length <= 64 ? label : `${label.slice(0, 61)}...`,
          `sg:${recipient.actionRef}`
        );
    }
  }

  keyboard
    .row()
    .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home);
  if (inactive) {
    keyboard
      .row()
      .text(translate(language, 'nav.status'), NAVIGATION_CALLBACKS.status)
      .text(translate(language, 'nav.help'), NAVIGATION_CALLBACKS.help);
  }

  return {
    text: [
      translate(language, 'settings.title'),
      '',
      ...entitlementLines(entitlement, language, timezoneOf(result)),
      '',
      translate(language, 'settings.language', {
        value: translate(
          language,
          settings.language === 'FA' ? 'label.fa' : 'label.en'
        ),
      }),
      translate(language, 'settings.timezone', {
        value: isolateLtr(settings.timezone),
      }),
      translate(language, 'settings.threshold', {
        value:
          settings.lowStockThreshold === null
            ? translate(language, 'general.notConfigured')
            : formatNumber(settings.lowStockThreshold, language),
      }),
      translate(language, 'settings.notifications', {
        value:
          categories.length > 0
            ? categories.join(', ')
            : translate(language, 'general.none'),
      }),
      translate(language, 'settings.recipients', {
        value: recipientModeLabel(settings.recipientMode, language),
      }),
      translate(language, 'settings.selected', {
        selected: formatNumber(settings.selectedRecipientCount, language),
        available: formatNumber(settings.availableRecipientCount, language),
      }),
      ...(recipients.length > 0
        ? ['', translate(language, 'settings.selectedManagers'), ...recipients]
        : []),
      ...(!settings.editable
        ? ['', translate(language, 'settings.readOnly')]
        : []),
      ...(inactive
        ? ['', translate(language, 'entitlement.settingsInactive')]
        : []),
    ].join('\n'),
    keyboard,
  };
}

function renderSettingsInputStart(
  result: SettingsInputStartResult
): RenderedView {
  const language = languageOf(result);
  if (result.state !== 'OK' || !result.purpose || !result.inputRef) {
    return renderRecoveryView(
      settingsStateMessage(result.state, language),
      result.state === 'UNAUTHORIZED' || result.state === 'NO_ACTIVE_STORE'
        ? 'status'
        : 'settings',
      language
    );
  }

  return {
    text:
      result.purpose === 'TIMEZONE'
        ? translate(language, 'settings.timezoneReady')
        : translate(language, 'settings.thresholdReady'),
    keyboard: new InlineKeyboard()
      .text(
        translate(language, 'nav.backSettings'),
        NAVIGATION_CALLBACKS.settings
      )
      .row()
      .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home),
  };
}

function settingsStateMessage(
  state: SettingsResult['state'],
  language: TelegramLanguage
): string {
  switch (state) {
    case 'FORBIDDEN_ROLE':
      return translate(language, 'settings.forbidden');
    case 'UNAUTHORIZED':
      return translate(language, 'settings.unauthorized');
    case 'NO_ACTIVE_STORE':
      return translate(language, 'general.noActiveStore');
    case 'INVALID_VALUE':
      return translate(language, 'settings.invalid');
    case 'EXPIRED_REF':
      return translate(language, 'settings.expiredInput');
    case 'CONTEXT_CHANGED':
      return translate(language, 'settings.contextChanged');
    default:
      return translate(language, 'settings.unavailable');
  }
}

function notificationCategoryLabel(
  category: 'ORDER_CREATED' | 'LOW_STOCK',
  language: TelegramLanguage
): string {
  return translate(
    language,
    category === 'ORDER_CREATED'
      ? 'label.orderCreated'
      : 'label.lowStockCategory'
  );
}

function recipientModeLabel(
  mode: SettingsSummary['recipientMode'],
  language: TelegramLanguage
): string {
  return translate(
    language,
    mode === 'ALL_ELIGIBLE' ? 'label.allEligible' : 'label.selected'
  );
}

function renderRecoveryView(
  text: string,
  primary:
    'orders' | 'status' | 'help' | 'settings' | 'stock' | 'search' | 'report',
  language: TelegramLanguage = 'en'
): RenderedView {
  const labels = {
    orders: translate(language, 'nav.refreshOrders'),
    status: translate(language, 'nav.checkStatus'),
    help: translate(language, 'nav.help'),
    settings: translate(language, 'nav.settings'),
    stock: translate(language, 'nav.refreshStock'),
    search: translate(language, 'nav.search'),
    report: translate(language, 'nav.report'),
  } as const;

  return {
    text,
    keyboard: new InlineKeyboard()
      .text(labels[primary], NAVIGATION_CALLBACKS[primary])
      .row()
      .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home),
  };
}

function renderEntitlementInactive(result: {
  presentation?: {
    language?: string;
    timezone?: string;
    entitlement?: EntitlementSummary | null;
  };
  entitlement?: EntitlementSummary | null;
}): RenderedView {
  const language = languageOf(result);
  const entitlement =
    result.entitlement ?? result.presentation?.entitlement ?? null;
  const text = entitlementRequiredMessage(entitlement, language);

  return {
    text: entitlement
      ? [
          text,
          '',
          ...entitlementLines(entitlement, language, timezoneOf(result)),
        ].join('\n')
      : text,
    keyboard: new InlineKeyboard()
      .text(translate(language, 'nav.status'), NAVIGATION_CALLBACKS.status)
      .text(translate(language, 'nav.help'), NAVIGATION_CALLBACKS.help)
      .row()
      .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home),
  };
}

function entitlementRequiredMessage(
  entitlement: EntitlementSummary | null | undefined,
  language: TelegramLanguage
): string {
  return translate(
    language,
    entitlement?.effectiveState === 'EXPIRED'
      ? 'entitlement.requiredExpired'
      : 'entitlement.requiredSuspended'
  );
}

function entitlementLines(
  entitlement: EntitlementSummary,
  language: TelegramLanguage,
  timezone: string
): string[] {
  const planKey =
    entitlement.plan === 'FREE'
      ? 'label.planFree'
      : entitlement.plan === 'PRO'
        ? 'label.planPro'
        : 'label.planAgency';
  const accessKey =
    entitlement.effectiveState === 'ACTIVE'
      ? 'label.entitlementActive'
      : entitlement.effectiveState === 'EXPIRED'
        ? 'label.entitlementExpired'
        : 'label.entitlementSuspended';

  return [
    translate(language, 'entitlement.plan', {
      value: translate(language, planKey),
    }),
    translate(language, 'entitlement.access', {
      value: translate(language, accessKey),
    }),
    translate(language, 'entitlement.expiry', {
      value: entitlement.expiresAt
        ? formatDateTime(entitlement.expiresAt, language, timezone)
        : translate(language, 'entitlement.noExpiry'),
    }),
  ];
}

function renderTransportFailure(
  error: unknown,
  primary:
    | 'orders'
    | 'status'
    | 'help'
    | 'settings'
    | 'stock'
    | 'search'
    | 'report' = 'help',
  language: TelegramLanguage = 'fa'
): RenderedView {
  return renderRecoveryView(
    transportFailureMessage(error, language),
    primary,
    language
  );
}

function homeKeyboard(language: TelegramLanguage): InlineKeyboard {
  return new InlineKeyboard()
    .text(translate(language, 'nav.orders'), NAVIGATION_CALLBACKS.orders)
    .text(translate(language, 'nav.stock'), NAVIGATION_CALLBACKS.stock)
    .row()
    .text(translate(language, 'nav.search'), NAVIGATION_CALLBACKS.search)
    .text(translate(language, 'nav.report'), NAVIGATION_CALLBACKS.report)
    .row()
    .text(translate(language, 'nav.settings'), NAVIGATION_CALLBACKS.settings)
    .row()
    .text(translate(language, 'nav.status'), NAVIGATION_CALLBACKS.status)
    .text(translate(language, 'nav.help'), NAVIGATION_CALLBACKS.help);
}

function isReadyStatus(status: TelegramAuthorizationStatus): boolean {
  return Boolean(
    status.linked &&
    status.authorized &&
    !status.selectionRequired &&
    status.activeTenantId &&
    status.activeStoreId &&
    (!status.entitlement || status.entitlement.effectiveState === 'ACTIVE')
  );
}

export function renderStatus(status: {
  linked: boolean;
  authorized: boolean;
  selectionRequired: boolean;
  activeTenantId: string | null;
  activeStoreId: string | null;
  entitlement?: EntitlementSummary | null;
  presentation?: { language?: string; timezone?: string };
}): string {
  const language = languageOf(status);
  const state = !status.linked
    ? translate(language, 'status.unlinked')
    : !status.authorized
      ? translate(language, 'status.noMembership')
      : status.selectionRequired
        ? translate(language, 'status.selectionRequired')
        : status.activeTenantId && status.activeStoreId
          ? !status.entitlement ||
            status.entitlement.effectiveState === 'ACTIVE'
            ? translate(language, 'status.ready')
            : entitlementRequiredMessage(status.entitlement, language)
          : translate(language, 'status.noStore');

  return status.entitlement
    ? [
        state,
        '',
        ...entitlementLines(status.entitlement, language, timezoneOf(status)),
      ].join('\n')
    : state;
}

export function renderStockList(result: StockListResult): RenderedView {
  const language = languageOf(result);
  if (result.state === 'ENTITLEMENT_INACTIVE') {
    return renderEntitlementInactive(result);
  }
  if (result.state === 'SYNCING') {
    return renderRecoveryView(
      translate(language, 'stock.syncing'),
      'stock',
      language
    );
  }

  if (result.state === 'SYNC_FAILED') {
    return renderRecoveryView(
      translate(language, 'stock.syncFailed'),
      'stock',
      language
    );
  }

  if (result.state === 'CONTEXT_CHANGED') {
    return renderRecoveryView(
      translate(language, 'stock.expired'),
      'stock',
      language
    );
  }

  if (result.state === 'UNAUTHORIZED') {
    return renderRecoveryView(
      translate(language, 'stock.unauthorized'),
      'status',
      language
    );
  }

  if (result.state === 'NO_ACTIVE_STORE') {
    return renderRecoveryView(
      translate(language, 'general.noActiveStore'),
      'status',
      language
    );
  }

  const keyboard = new InlineKeyboard();

  for (const item of result.items) {
    const status = inventoryLabel(item.classification, language);
    const quantity =
      item.quantity === null
        ? ''
        : ` • ${formatNumber(item.quantity, language)}`;
    const label = `${status} • ${item.displayName}${quantity}`;
    keyboard
      .text(label.length <= 64 ? label : `${label.slice(0, 61)}...`, item.ref)
      .row();
  }

  if (result.previousCursor) {
    keyboard.text(translate(language, 'nav.previous'), result.previousCursor);
  }

  if (result.nextCursor) {
    keyboard.text(translate(language, 'nav.next'), result.nextCursor);
  }

  keyboard
    .row()
    .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home);

  return {
    text: [
      translate(language, 'stock.title'),
      '',
      result.threshold === null
        ? translate(language, 'stock.thresholdUnset')
        : translate(language, 'stock.threshold', {
            value: formatNumber(result.threshold, language),
          }),
      '',
      ...(result.items.length === 0
        ? [translate(language, 'stock.empty')]
        : result.items.map((item) => {
            const status = inventoryLabel(item.classification, language);
            return `${status} • ${item.displayName}${
              item.quantity === null
                ? ''
                : ` • ${translate(language, 'stock.qtyShort', {
                    value: formatNumber(item.quantity, language),
                  })}`
            }`;
          })),
    ].join('\n'),
    keyboard,
  };
}

export function renderStockDetail(result: StockDetailResult): RenderedView {
  const language = languageOf(result);
  const timezone = timezoneOf(result);
  if (result.state === 'ENTITLEMENT_INACTIVE') {
    return renderEntitlementInactive(result);
  }
  if (result.state === 'CONTEXT_CHANGED') {
    return renderRecoveryView(
      translate(language, 'stock.itemExpired'),
      'stock',
      language
    );
  }

  if (result.state === 'UNAUTHORIZED') {
    return renderRecoveryView(
      translate(language, 'stock.unauthorized'),
      'status',
      language
    );
  }

  if (result.state === 'NO_ACTIVE_STORE') {
    return renderRecoveryView(
      translate(language, 'general.noActiveStore'),
      'status',
      language
    );
  }

  if (result.state !== 'OK' || !result.item || !result.backCursor) {
    return renderRecoveryView(
      translate(language, 'stock.noLongerAlerting'),
      'stock',
      language
    );
  }

  const item = result.item;
  const variation = item.variationContext.map(
    (attribute) => `${attribute.name}: ${attribute.option}`
  );

  return {
    text: [
      inventoryLabel(item.classification, language),
      '',
      item.displayName,
      ...(variation.length > 0
        ? [
            translate(language, 'stock.variation', {
              value: variation.join(', '),
            }),
          ]
        : []),
      ...(item.sku
        ? [translate(language, 'stock.sku', { value: isolateLtr(item.sku) })]
        : []),
      translate(language, 'stock.quantity', {
        value:
          item.quantity === null
            ? translate(language, 'general.notManaged')
            : formatNumber(item.quantity, language),
      }),
      translate(language, 'stock.wooStatus', {
        value: isolateLtr(item.stockStatus),
      }),
      translate(language, 'stock.wctmThreshold', {
        value:
          item.threshold === null
            ? translate(language, 'general.notConfigured')
            : formatNumber(item.threshold, language),
      }),
      translate(language, 'stock.lastSynced', {
        value: formatDateTime(item.lastSyncedAt, language, timezone),
      }),
    ].join('\n'),
    keyboard: new InlineKeyboard()
      .text(translate(language, 'nav.backStock'), result.backCursor)
      .row()
      .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home),
  };
}

function renderSearchUsage(language: TelegramLanguage = 'en'): RenderedView {
  return {
    text: [
      translate(language, 'search.title'),
      '',
      translate(language, 'search.usage'),
      translate(language, 'search.prefix'),
    ].join('\n'),
    keyboard: new InlineKeyboard().text(
      translate(language, 'nav.home'),
      NAVIGATION_CALLBACKS.home
    ),
  };
}

export function renderSearch(result: SearchResult): RenderedView {
  const language = languageOf(result);
  if (result.state === 'ENTITLEMENT_INACTIVE') {
    return renderEntitlementInactive(result);
  }
  if (result.state === 'ORDER_DETAIL') {
    return renderOrderDetail({
      ...result.detail,
      presentation: result.presentation,
    });
  }

  if (result.state === 'INVALID_QUERY') {
    return renderSearchUsage(language);
  }

  if (result.state === 'QUERY_TOO_SHORT') {
    return renderRecoveryView(
      translate(language, 'search.tooShort'),
      'search',
      language
    );
  }

  if (result.state === 'UNAUTHORIZED') {
    return renderRecoveryView(
      translate(language, 'search.unauthorized'),
      'status',
      language
    );
  }

  if (result.state === 'NO_ACTIVE_STORE') {
    return renderRecoveryView(
      translate(language, 'general.noActiveStore'),
      'status',
      language
    );
  }

  if (result.state === 'CONTEXT_CHANGED') {
    return renderRecoveryView(
      translate(language, 'search.expired'),
      'search',
      language
    );
  }

  if (result.state !== 'OK') {
    return renderSearchUsage(language);
  }

  const keyboard = new InlineKeyboard();

  for (const row of result.results) {
    const label =
      row.kind === 'ORDER'
        ? `${translate(language, 'orders.order', {
            number: isolateLtr(row.orderNumber ?? ''),
          })} • ${statusLabel(row.status, language)}`
        : `${inventoryLabel(row.classification ?? 'HEALTHY', language)} • ${row.displayName}${row.sku ? ` • ${isolateLtr(row.sku)}` : ''}`;
    keyboard
      .text(label.length <= 64 ? label : `${label.slice(0, 61)}...`, row.ref)
      .row();
  }

  if (result.previousCursor) {
    keyboard.text(translate(language, 'nav.previous'), result.previousCursor);
  }
  if (result.nextCursor) {
    keyboard.text(translate(language, 'nav.next'), result.nextCursor);
  }
  keyboard
    .row()
    .text(translate(language, 'nav.newSearch'), NAVIGATION_CALLBACKS.search);
  keyboard.text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home);

  return {
    text: [
      translate(language, 'search.results'),
      '',
      ...(result.results.length === 0
        ? [translate(language, 'search.empty')]
        : result.results.map((row) =>
            row.kind === 'ORDER'
              ? `${translate(language, 'orders.order', {
                  number: isolateLtr(row.orderNumber ?? ''),
                })} • ${statusLabel(row.status, language)} • ${formatMoney(
                  row.total ?? '',
                  row.currency ?? '',
                  language
                )}${row.customerDisplayName ? ` • ${row.customerDisplayName}` : ''}`
              : `${inventoryLabel(row.classification ?? 'HEALTHY', language)} • ${row.displayName}${row.sku ? ` • ${translate(language, 'stock.sku', { value: isolateLtr(row.sku) })}` : ''}${row.quantity === null ? '' : ` • ${translate(language, 'stock.qtyShort', { value: formatNumber(row.quantity ?? '', language) })}`}`
          )),
      ...(result.inventoryState === 'READY'
        ? []
        : ['', translate(language, 'search.partial')]),
    ].join('\n'),
    keyboard,
  };
}

export function renderSearchSelection(
  result: SearchSelectionResult
): RenderedView {
  const language = languageOf(result);
  const timezone = timezoneOf(result);
  if (result.state === 'ENTITLEMENT_INACTIVE') {
    return renderEntitlementInactive(result);
  }
  if (result.state === 'ORDER') {
    const rendered = renderOrderDetail({
      ...result.detail,
      presentation: result.presentation,
    });
    rendered.keyboard
      .row()
      .text(translate(language, 'nav.backSearch'), result.backCursor);
    return rendered;
  }

  if (result.state === 'INVENTORY') {
    const item = result.detail.item;
    const variation = item.variationContext.map(
      (attribute) => `${attribute.name}: ${attribute.option}`
    );

    return {
      text: [
        item.classification === 'OUT_OF_STOCK'
          ? inventoryLabel('OUT_OF_STOCK', language)
          : item.classification === 'LOW_STOCK'
            ? inventoryLabel('LOW_STOCK', language)
            : inventoryLabel('HEALTHY', language),
        '',
        item.displayName,
        ...(variation.length > 0
          ? [
              translate(language, 'stock.variation', {
                value: variation.join(', '),
              }),
            ]
          : []),
        ...(item.sku
          ? [translate(language, 'stock.sku', { value: isolateLtr(item.sku) })]
          : []),
        translate(language, 'stock.quantity', {
          value:
            item.quantity === null
              ? translate(language, 'general.notManaged')
              : formatNumber(item.quantity, language),
        }),
        translate(language, 'stock.wooStatus', {
          value: isolateLtr(item.stockStatus),
        }),
        translate(language, 'stock.wctmClass', {
          value: inventoryLabel(item.classification, language),
        }),
        translate(language, 'stock.wctmThreshold', {
          value:
            item.threshold === null
              ? translate(language, 'general.notConfigured')
              : formatNumber(item.threshold, language),
        }),
        translate(language, 'stock.lastSynced', {
          value: formatDateTime(item.lastSyncedAt, language, timezone),
        }),
      ].join('\n'),
      keyboard: new InlineKeyboard()
        .text(translate(language, 'nav.backSearch'), result.backCursor)
        .row()
        .text(translate(language, 'nav.stock'), NAVIGATION_CALLBACKS.stock)
        .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home),
    };
  }

  if (result.state === 'UNAUTHORIZED') {
    return renderRecoveryView(
      translate(language, 'search.resultUnauthorized'),
      'status',
      language
    );
  }

  if (result.state === 'NO_ACTIVE_STORE') {
    return renderRecoveryView(
      translate(language, 'general.noActiveStore'),
      'status',
      language
    );
  }

  return renderRecoveryView(
    result.state === 'SYNCING'
      ? translate(language, 'search.inventorySyncing')
      : translate(language, 'search.resultExpired'),
    'search',
    language
  );
}

export function renderDailyReport(result: DailyReportResult): RenderedView {
  const language = languageOf(result);
  const timezone = timezoneOf(result);
  if (result.state === 'ENTITLEMENT_INACTIVE') {
    return renderEntitlementInactive(result);
  }
  if (result.state === 'UNAUTHORIZED') {
    return renderRecoveryView(
      translate(language, 'report.unauthorized'),
      'status',
      language
    );
  }

  if (result.state === 'NO_ACTIVE_STORE') {
    return renderRecoveryView(
      translate(language, 'general.noActiveStore'),
      'status',
      language
    );
  }

  if (result.state !== 'OK') {
    return renderRecoveryView(
      translate(language, 'report.unavailable'),
      'report',
      language
    );
  }

  const sales =
    result.sales.length === 0
      ? [translate(language, 'report.grossNone')]
      : result.sales.flatMap((currency) => [
          translate(language, 'report.gross', {
            currency: isolateLtr(currency.currency),
            value: formatMoney(currency.gross, currency.currency, language),
          }),
          translate(language, 'report.aov', {
            currency: isolateLtr(currency.currency),
            value: formatMoney(
              currency.averageOrderValue,
              currency.currency,
              language
            ),
          }),
        ]);
  const statuses =
    result.statuses.length === 0
      ? [translate(language, 'report.statusNone')]
      : [
          translate(language, 'report.statuses'),
          ...result.statuses.map(
            (status) =>
              `• ${statusLabel(status.status, language)}: ${formatNumber(
                status.count,
                language
              )}`
          ),
        ];
  const inventory =
    result.inventory.state === 'READY'
      ? [
          translate(language, 'report.low', {
            value: formatNumber(result.inventory.lowStock, language),
          }),
          translate(language, 'report.out', {
            value: formatNumber(result.inventory.outOfStock, language),
          }),
        ]
      : [
          translate(language, 'report.inventoryUnavailable', {
            value: isolateLtr(result.inventory.syncState),
          }),
        ];

  return {
    text: [
      translate(language, 'report.title'),
      `${
        result.dayStartUtc
          ? formatDate(result.dayStartUtc, language, timezone)
          : isolateLtr(result.localDate)
      } • ${isolateLtr(timezone)}`,
      '',
      translate(language, 'report.ordersToday', {
        value: formatNumber(result.ordersToday, language),
      }),
      ...sales,
      ...(result.omittedRevenueOrders > 0
        ? [
            translate(language, 'report.omitted', {
              value: formatNumber(result.omittedRevenueOrders, language),
            }),
          ]
        : []),
      '',
      ...statuses,
      '',
      ...inventory,
      ...(result.projection.delayed
        ? ['', translate(language, 'report.delayed')]
        : []),
      '',
      translate(language, 'report.disclaimer'),
    ].join('\n'),
    keyboard: new InlineKeyboard()
      .text(translate(language, 'nav.orders'), NAVIGATION_CALLBACKS.orders)
      .text(translate(language, 'nav.stock'), NAVIGATION_CALLBACKS.stock)
      .row()
      .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home),
  };
}

export function renderOrderList(result: OrderListResult): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const language = languageOf(result);
  const timezone = timezoneOf(result);
  if (result.state === 'ENTITLEMENT_INACTIVE') {
    return renderEntitlementInactive(result);
  }
  if (result.state === 'CONTEXT_CHANGED') {
    return renderRecoveryView(
      translate(language, 'general.expiredList'),
      'orders',
      language
    );
  }

  if (result.state === 'UNAUTHORIZED') {
    return renderRecoveryView(
      translate(language, 'general.unauthorizedOrders'),
      'status',
      language
    );
  }

  if (result.state === 'NO_ACTIVE_STORE') {
    return renderRecoveryView(
      translate(language, 'general.noActiveStore'),
      'status',
      language
    );
  }

  const keyboard = new InlineKeyboard();

  for (const order of result.orders) {
    keyboard.text(orderButtonLabel(order, language), order.ref).row();
  }

  if (result.previousCursor) {
    keyboard.text(translate(language, 'nav.previous'), result.previousCursor);
  }

  if (result.nextCursor) {
    keyboard.text(translate(language, 'nav.next'), result.nextCursor);
  }

  keyboard
    .row()
    .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home);

  const text =
    result.orders.length === 0
      ? [
          translate(language, 'orders.title'),
          '',
          translate(language, 'orders.empty'),
          translate(language, 'orders.emptyHint'),
        ].join('\n')
      : [
          translate(language, 'orders.title'),
          '',
          ...result.orders.map(
            (order) =>
              `${translate(language, 'orders.order', {
                number: isolateLtr(order.orderNumber),
              })} • ${statusLabel(order.status, language)} • ${formatMoney(
                order.total,
                order.currency,
                language
              )}${
                order.remoteDeleted
                  ? ` • ${translate(language, 'general.deleted')}`
                  : ''
              }`
          ),
          '',
          freshnessLine(result.freshness, language, timezone),
        ].join('\n');

  return { text, keyboard };
}

export function renderOrderDetail(result: OrderDetailResult): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const language = languageOf(result);
  const timezone = timezoneOf(result);
  if (result.state === 'ENTITLEMENT_INACTIVE') {
    return renderEntitlementInactive(result);
  }
  if (result.state === 'CONTEXT_CHANGED') {
    return renderRecoveryView(
      translate(language, 'general.expiredList'),
      'orders',
      language
    );
  }

  if (result.state === 'UNAUTHORIZED') {
    return renderRecoveryView(
      translate(language, 'general.unauthorizedOrders'),
      'status',
      language
    );
  }

  if (result.state === 'NO_ACTIVE_STORE') {
    return renderRecoveryView(
      translate(language, 'general.noActiveStore'),
      'status',
      language
    );
  }

  const keyboard = orderDetailKeyboard(
    result.backCursor,
    result.transitionsRef,
    result.refreshRef,
    result.addNoteRef,
    language
  );

  if (result.state === 'NOT_FOUND' || !result.order) {
    return {
      text: translate(language, 'orders.notFound'),
      keyboard,
    };
  }

  if (result.state === 'DELETED' || result.order.remoteDeleted) {
    return {
      text: [
        translate(language, 'orders.order', {
          number: isolateLtr(result.order.orderNumber),
        }),
        translate(language, 'orders.status', {
          value: statusLabel(result.order.status, language),
        }),
        translate(language, 'orders.customer', {
          value: result.order.customerDisplayName,
        }),
        translate(language, 'orders.deletedWoo'),
        freshnessLine(result.freshness, language, timezone),
      ].join('\n'),
      keyboard,
    };
  }

  return {
    text: renderActiveOrderDetail(
      result.order,
      result.freshness,
      language,
      timezone
    ),
    keyboard,
  };
}

export function renderOrderLookup(result: OrderLookupResult): RenderedView {
  const language = languageOf(result);
  if (result.state === 'MALFORMED_ORDER_NUMBER') {
    return renderRecoveryView(
      translate(language, 'orders.lookupUsage'),
      'orders',
      language
    );
  }

  if (result.state === 'AMBIGUOUS') {
    return renderRecoveryView(
      translate(language, 'orders.ambiguous'),
      'orders',
      language
    );
  }

  return renderOrderDetail(result as OrderDetailResult);
}

export function renderOrderRefresh(result: OrderRefreshResult): RenderedView {
  const language = languageOf(result);
  if (result.state === 'OK' || result.state === 'DELETED') {
    const rendered = renderOrderDetail(result as OrderDetailResult);

    return {
      text: `${translate(language, 'orders.refreshed')}\n\n${rendered.text}`,
      keyboard: rendered.keyboard,
    };
  }

  if (result.state === 'RETRYABLE') {
    return renderRecoveryView(
      translate(language, 'orders.refreshRetryable'),
      'orders',
      language
    );
  }

  if (result.state === 'FAILED') {
    return renderRecoveryView(
      translate(language, 'orders.refreshFailed'),
      'orders',
      language
    );
  }

  return renderOrderDetail(result as OrderDetailResult);
}

export function renderOrderNoteOptions(
  result: OrderNoteOptionsResult,
  detailRef: string
): RenderedView {
  const language = languageOf(result);
  if (result.state === 'ENTITLEMENT_INACTIVE') {
    return renderEntitlementInactive(result);
  }
  if (result.state !== 'OK' || !result.ref || !result.visibilities) {
    return renderOrderNoteFailure(result.state, detailRef, language);
  }

  const keyboard = new InlineKeyboard();

  for (const visibility of result.visibilities) {
    keyboard
      .text(
        noteVisibilityLabel(visibility, language),
        `v:${result.ref}:${visibility}`
      )
      .row();
  }

  keyboard
    .text(translate(language, 'nav.backOrder'), detailRef)
    .row()
    .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home);

  return {
    text: [
      translate(language, 'notes.title'),
      '',
      translate(language, 'notes.internalHelp'),
      translate(language, 'notes.customerHelp'),
      '',
      translate(language, 'notes.choose'),
    ].join('\n'),
    keyboard,
  };
}

export function renderOrderNoteStart(
  result: OrderNoteStartResult
): RenderedView {
  const language = languageOf(result);
  if (result.state === 'ENTITLEMENT_INACTIVE') {
    return renderEntitlementInactive(result);
  }
  if (
    result.state !== 'OK' ||
    !result.inputRef ||
    !result.detailRef ||
    !result.visibility
  ) {
    return renderOrderNoteFailure(result.state, result.detailRef, language);
  }

  return {
    text: [
      translate(language, 'notes.title'),
      '',
      translate(language, 'notes.visibility', {
        value: noteVisibilityLabel(result.visibility, language),
      }),
      translate(language, 'notes.replyReview'),
    ].join('\n'),
    keyboard: new InlineKeyboard()
      .text(translate(language, 'action.cancel'), `x:${result.inputRef}`)
      .row()
      .text(translate(language, 'nav.backOrder'), result.detailRef)
      .row()
      .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home),
  };
}

export function renderOrderNotePrepare(
  result: OrderNotePrepareResult,
  inputRef: string
): RenderedView {
  const language = languageOf(result);
  if (result.state === 'ENTITLEMENT_INACTIVE') {
    return renderEntitlementInactive(result);
  }
  if (
    result.state !== 'OK' ||
    !result.confirmRef ||
    !result.detailRef ||
    !result.visibility ||
    result.preview === undefined
  ) {
    if (result.state === 'INVALID_NOTE') {
      return {
        text: translate(language, 'notes.invalidDetailed'),
        keyboard: new InlineKeyboard()
          .text(translate(language, 'action.cancel'), `x:${inputRef}`)
          .row()
          .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home),
      };
    }

    return renderOrderNoteFailure(result.state, result.detailRef, language);
  }

  return {
    text: [
      translate(language, 'notes.confirmTitle'),
      '',
      translate(language, 'notes.visibility', {
        value: noteVisibilityLabel(result.visibility, language),
      }),
      translate(language, 'notes.preview', { value: result.preview }),
      '',
      translate(language, 'notes.confirmHelp'),
    ].join('\n'),
    keyboard: new InlineKeyboard()
      .text(translate(language, 'action.confirm'), `nc:${result.confirmRef}`)
      .text(translate(language, 'action.cancel'), `x:${result.confirmRef}`)
      .row()
      .text(translate(language, 'nav.backOrder'), result.detailRef)
      .row()
      .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home),
  };
}

export function renderOrderNoteMutation(
  result: OrderNoteMutationResult
): RenderedView {
  const language = languageOf(result);
  if (result.state === 'ENTITLEMENT_INACTIVE') {
    return renderEntitlementInactive(result);
  }
  const keyboard = new InlineKeyboard();

  if (result.detailRef) {
    keyboard.text(translate(language, 'nav.backOrder'), result.detailRef).row();
  } else {
    keyboard
      .text(translate(language, 'nav.orders'), NAVIGATION_CALLBACKS.orders)
      .row();
  }

  keyboard.text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home);

  return {
    text: orderNoteStateMessage(result, language),
    keyboard,
  };
}

export function renderOrderTransitions(
  result: OrderTransitionsResult,
  detailRef: string
): { text: string; keyboard: InlineKeyboard } {
  const language = languageOf(result);
  if (result.state === 'ENTITLEMENT_INACTIVE') {
    return renderEntitlementInactive(result);
  }
  if (result.state !== 'OK' || !result.ref || !result.targets) {
    if (result.state === 'CONTEXT_CHANGED') {
      return renderRecoveryView(
        translate(language, 'general.expiredList'),
        'orders',
        language
      );
    }

    if (result.state === 'UNAUTHORIZED') {
      return renderRecoveryView(
        translate(language, 'general.unauthorizedOrders'),
        'status',
        language
      );
    }

    if (result.state === 'NO_ACTIVE_STORE') {
      return renderRecoveryView(
        translate(language, 'general.noActiveStore'),
        'status',
        language
      );
    }

    if (result.state === 'NOT_FOUND' || result.state === 'DELETED') {
      return renderRecoveryView(
        orderWriteStateMessage(result.state, language),
        'orders',
        language
      );
    }

    return {
      text: orderWriteStateMessage(result.state, language),
      keyboard: new InlineKeyboard()
        .text(translate(language, 'nav.backOrder'), detailRef)
        .row()
        .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home),
    };
  }

  const keyboard = new InlineKeyboard();

  for (const target of result.targets) {
    keyboard
      .text(statusLabel(target, language), `${result.ref}:${target}`)
      .row();
  }

  keyboard
    .text(translate(language, 'nav.backOrder'), detailRef)
    .row()
    .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home);

  return {
    text:
      result.targets.length === 0
        ? translate(language, 'statusChange.none', {
            value: result.currentStatus
              ? statusLabel(result.currentStatus, language)
              : translate(language, 'label.currentStatus'),
          })
        : [
            translate(language, 'statusChange.title'),
            '',
            translate(language, 'statusChange.current', {
              value: result.currentStatus
                ? statusLabel(result.currentStatus, language)
                : translate(language, 'label.currentStatus'),
            }),
            translate(language, 'statusChange.choose'),
          ].join('\n'),
    keyboard,
  };
}

export function renderOrderStatusUpdate(result: OrderStatusUpdateResult): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const language = languageOf(result);
  if (result.state === 'ENTITLEMENT_INACTIVE') {
    return renderEntitlementInactive(result);
  }
  if (result.order && result.freshness) {
    const completed = result.state === 'OK' || result.state === 'NO_OP';
    const rendered = renderOrderDetail({
      state: 'OK',
      order: result.order,
      ...(completed && result.backCursor
        ? { backCursor: result.backCursor }
        : {}),
      freshness: result.freshness,
      presentation: result.presentation,
    });

    return {
      text: `${
        result.state === 'OK'
          ? translate(language, 'statusChange.success')
          : result.state === 'NO_OP'
            ? translate(language, 'statusChange.noOp')
            : orderWriteStateMessage(result.state, language)
      }\n\n${rendered.text}`,
      keyboard: rendered.keyboard,
    };
  }

  if (result.state === 'UNAUTHORIZED' || result.state === 'NO_ACTIVE_STORE') {
    return renderRecoveryView(
      orderWriteStateMessage(result.state, language),
      'status',
      language
    );
  }

  return renderRecoveryView(
    orderWriteStateMessage(result.state, language),
    'orders',
    language
  );
}

function orderWriteStateMessage(
  state: OrderTransitionsResult['state'] | OrderStatusUpdateResult['state'],
  language: TelegramLanguage
): string {
  switch (state) {
    case 'FORBIDDEN_ROLE':
      return translate(language, 'statusChange.forbidden');
    case 'UNAUTHORIZED':
      return translate(language, 'general.unauthorizedOrders');
    case 'NO_ACTIVE_STORE':
      return translate(language, 'general.noActiveStore');
    case 'CONTEXT_CHANGED':
      return translate(language, 'general.expiredList');
    case 'EXPIRED_REF':
      return translate(language, 'statusChange.expired');
    case 'INVALID_TARGET':
      return translate(language, 'statusChange.invalid');
    case 'RETRYABLE':
      return translate(language, 'statusChange.retryable');
    case 'FAILED':
      return translate(language, 'statusChange.failed');
    case 'DELETED':
      return translate(language, 'orders.deletedWoo');
    case 'NOT_FOUND':
      return translate(language, 'statusChange.notFound');
    default:
      return translate(language, 'statusChange.noneAvailable');
  }
}

function renderOrderNoteFailure(
  state: OrderNoteMutationResult['state'],
  detailRef: string | undefined,
  language: TelegramLanguage
): RenderedView {
  if (state === 'ENTITLEMENT_INACTIVE') {
    return renderEntitlementInactive({
      presentation: { language, timezone: 'UTC' },
    });
  }
  const keyboard = new InlineKeyboard();

  if (detailRef) {
    keyboard.text(translate(language, 'nav.backOrder'), detailRef).row();
  } else {
    keyboard
      .text(translate(language, 'nav.orders'), NAVIGATION_CALLBACKS.orders)
      .row();
  }

  keyboard.text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home);

  return { text: orderNoteStateMessage({ state }, language), keyboard };
}

function orderNoteStateMessage(
  result: OrderNoteMutationResult,
  language: TelegramLanguage
): string {
  switch (result.state) {
    case 'OK':
      return translate(language, 'notes.success', {
        visibility: noteVisibilityLabel(
          result.visibility ?? 'INTERNAL',
          language
        ),
        order: result.orderNumber
          ? translate(language, 'notes.forOrder', {
              number: isolateLtr(result.orderNumber),
            })
          : '',
      });
    case 'CANCELLED':
      return translate(language, 'notes.cancelled');
    case 'FORBIDDEN_ROLE':
      return translate(language, 'notes.forbidden');
    case 'UNAUTHORIZED':
      return translate(language, 'general.unauthorizedOrders');
    case 'NO_ACTIVE_STORE':
      return translate(language, 'general.noActiveStore');
    case 'CONTEXT_CHANGED':
      return translate(language, 'general.expiredList');
    case 'EXPIRED_REF':
      return translate(language, 'notes.expired');
    case 'INVALID_NOTE':
      return translate(language, 'notes.invalid');
    case 'IN_PROGRESS':
      return translate(language, 'notes.inProgress');
    case 'AMBIGUOUS':
      return translate(language, 'notes.ambiguous');
    case 'RETRYABLE':
      return translate(language, 'notes.retryable');
    case 'DELETED':
      return translate(language, 'notes.deleted');
    case 'NOT_FOUND':
      return translate(language, 'notes.notFound');
    default:
      return translate(language, 'notes.failed');
  }
}

function noteVisibilityLabel(
  visibility: OrderNoteVisibility,
  language: TelegramLanguage
): string {
  return translate(
    language,
    visibility === 'CUSTOMER' ? 'label.customer' : 'label.internal'
  );
}

function orderDetailKeyboard(
  backCursor?: string,
  transitionsRef?: string,
  refreshRef?: string,
  addNoteRef?: string,
  language: TelegramLanguage = 'en'
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (backCursor) {
    keyboard.text(translate(language, 'nav.backOrders'), backCursor);
  } else {
    keyboard.text(
      translate(language, 'nav.orders'),
      NAVIGATION_CALLBACKS.orders
    );
  }

  if (transitionsRef) {
    keyboard
      .row()
      .text(translate(language, 'action.changeStatus'), `t:${transitionsRef}`);
  }

  if (refreshRef) {
    keyboard
      .row()
      .text(translate(language, 'action.refresh'), `r:${refreshRef}`);
  }

  if (addNoteRef) {
    keyboard
      .row()
      .text(translate(language, 'action.addNote'), `n:${addNoteRef}`);
  }

  keyboard
    .row()
    .text(translate(language, 'nav.home'), NAVIGATION_CALLBACKS.home);
  return keyboard;
}

function noteInputReference(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  const match = text.match(
    /(?:^|\n)(?:Note reference:|شناسه یادداشت:) (i\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16})(?:\n|$)/
  );

  return match?.[1];
}

function settingsInputReference(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  const match = text.match(
    /(?:^|\n)(?:Settings reference:|شناسه تنظیمات:) (g\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16})(?:\n|$)/
  );

  return match?.[1];
}

async function handleViewCallback(
  context: Context,
  render: (identity: TelegramIdentity) => Promise<RenderedView>,
  log: (record: Readonly<Record<string, unknown>>) => void,
  recovery:
    | 'orders'
    | 'status'
    | 'help'
    | 'settings'
    | 'stock'
    | 'search'
    | 'report' = 'help'
): Promise<void> {
  const identity = privateIdentity(context);

  if (!identity) {
    await safeAnswerCallback(context);
    return;
  }

  try {
    const rendered = await render(identity);
    await safeAnswerCallback(context);
    await editOrReply(context, rendered.text, rendered.keyboard);
  } catch (error: unknown) {
    logTransportFailure(log, identity.updateId, error);
    await safeAnswerCallback(context);
    const rendered = renderTransportFailure(error, recovery);
    await editOrReply(context, rendered.text, rendered.keyboard);
  }
}

async function replyView(
  context: Context,
  rendered: RenderedView
): Promise<void> {
  await context.reply(rendered.text, { reply_markup: rendered.keyboard });
}

async function editOrReply(
  context: Context,
  text: string,
  keyboard: InlineKeyboard
): Promise<void> {
  try {
    await context.editMessageText(text, { reply_markup: keyboard });
  } catch {
    await context.reply(text, { reply_markup: keyboard });
  }
}

async function safeAnswerCallback(context: Context): Promise<void> {
  try {
    await context.answerCallbackQuery();
  } catch {
    // Acknowledgement failure does not change the backend operation outcome.
  }
}

function renderActiveOrderDetail(
  order: OrderDetailPayload,
  freshness: OrderDetailResult['freshness'],
  language: TelegramLanguage,
  timezone: string
): string {
  const total = order.totals?.['total'];
  const lines = (order.lineItems ?? []).map(
    (item) =>
      `• ${item.name} × ${formatNumber(item.quantity, language)} — ${formatNumber(
        item.total,
        language
      )}`
  );
  const payment = order.payment
    ? translate(language, 'orders.payment', {
        method:
          order.payment.method ?? translate(language, 'general.notSpecified'),
        state: translate(
          language,
          order.payment.paid ? 'label.paid' : 'label.unpaid'
        ),
      })
    : undefined;
  const shippingMethods = order.shipping?.methods.join(', ');
  const shippingAddress = order.shipping?.addressLines.join(' • ');

  return [
    translate(language, 'orders.order', {
      number: isolateLtr(order.orderNumber),
    }),
    translate(language, 'orders.status', {
      value: statusLabel(order.status, language),
    }),
    translate(language, 'orders.customer', {
      value: order.customerDisplayName,
    }),
    translate(language, 'orders.total', {
      value:
        total === undefined
          ? '—'
          : formatMoney(String(total), order.currency ?? '', language),
    }),
    ...(payment ? [payment] : []),
    ...(shippingMethods
      ? [translate(language, 'orders.shipping', { value: shippingMethods })]
      : []),
    ...(shippingAddress
      ? [translate(language, 'orders.shipTo', { value: shippingAddress })]
      : []),
    translate(language, 'orders.created', {
      value: order.wcCreatedAt
        ? formatDateTime(order.wcCreatedAt, language, timezone)
        : '—',
    }),
    translate(language, 'orders.modified', {
      value: order.wcModifiedAt
        ? formatDateTime(order.wcModifiedAt, language, timezone)
        : '—',
    }),
    ...(lines.length > 0
      ? ['', translate(language, 'orders.items'), ...lines]
      : []),
    '',
    freshnessLine(freshness, language, timezone),
  ].join('\n');
}

function freshnessLine(
  freshness: OrderListResult['freshness'],
  language: TelegramLanguage,
  timezone: string
): string {
  const date = formatDateTime(freshness.asOf, language, timezone);
  return `${translate(language, 'orders.lastUpdated', {
    value: date,
  })}${freshness.delayed ? ` • ${translate(language, 'orders.delayed')}` : ''}`;
}

function orderButtonLabel(
  order: OrderSummary,
  language: TelegramLanguage
): string {
  const label = `${isolateLtr(`#${order.orderNumber}`)} • ${statusLabel(
    order.status,
    language
  )} • ${formatMoney(order.total, order.currency, language)}`;

  return label.length <= 64 ? label : `${label.slice(0, 61)}...`;
}

function transportFailureMessage(
  error: unknown,
  language: TelegramLanguage
): string {
  return error?.constructor?.name === 'MalformedBackendResponseError'
    ? translate(language, 'general.malformedResponse')
    : translate(language, 'general.transientFailure');
}

async function configureChatCommandMenu(
  context: Context,
  language: TelegramLanguage,
  log: (record: Readonly<Record<string, unknown>>) => void
): Promise<void> {
  if (!context.chat || context.chat.type !== 'private') {
    return;
  }

  try {
    await context.api.setMyCommands(commandMenu(language), {
      scope: { type: 'chat', chat_id: context.chat.id },
    });
  } catch (error: unknown) {
    log({
      event: 'telegram_chat_command_menu_configuration_failed',
      correlationId: `telegram-update-${context.update.update_id.toString()}`,
      telegramUpdateId: context.update.update_id.toString(),
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

function logTransportFailure(
  log: (record: Readonly<Record<string, unknown>>) => void,
  updateId: string,
  error: unknown
): void {
  log({
    event: 'telegram_backend_request_failed',
    correlationId: `telegram-update-${updateId}`,
    telegramUpdateId: updateId,
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
}

export const BOT_MESSAGES = {
  privateOnly: translate('fa', 'general.privateOnly'),
  transientFailure: translate('fa', 'general.transientFailure'),
  invalidToken: translate('fa', 'general.invalidToken'),
  expiredList: translate('en', 'general.expiredList'),
  unauthorizedOrders: translate('fa', 'general.unauthorizedOrders'),
  noActiveStore: translate('fa', 'general.noActiveStore'),
  malformedResponse: translate('fa', 'general.malformedResponse'),
} as const;
