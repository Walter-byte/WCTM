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
  TelegramAuthorizationStatus,
  TelegramIdentity,
} from './internal-backend.client';
import { UpdateDeduplicator } from './update-deduplicator';

const PRIVATE_ONLY_MESSAGE =
  'This bot can only be used in a private Telegram chat.';
const TRANSIENT_FAILURE_MESSAGE =
  'The service is temporarily unavailable. Return Home or try again shortly.';
const INVALID_TOKEN_MESSAGE =
  'This link token is invalid or expired. Request a new token and try again.';
const EXPIRED_LIST_MESSAGE =
  'This order view expired or the active context changed. Refresh Recent Orders to continue.';
const UNAUTHORIZED_ORDERS_MESSAGE =
  'This chat is not authorized to view orders. Check Status for recovery details.';
const NO_ACTIVE_STORE_MESSAGE =
  'No single active store is available for this chat. Check Status before trying again.';
const MALFORMED_RESPONSE_MESSAGE =
  'The service returned an unexpected response. Return Home or try again shortly.';
const NOTE_REFERENCE_LABEL = 'Note reference:';
const SETTINGS_REFERENCE_LABEL = 'Settings reference:';

const NAVIGATION_CALLBACKS = {
  home: 'nav:home',
  orders: 'nav:orders',
  status: 'nav:status',
  help: 'nav:help',
  settings: 'nav:settings',
} as const;

export const BOT_COMMANDS = [
  { command: 'start', description: 'Open Home or link your account' },
  { command: 'orders', description: 'Open recent orders' },
  { command: 'order', description: 'Open an exact order number' },
  { command: 'status', description: 'Check account and store access' },
  { command: 'settings', description: 'View or manage store settings' },
  { command: 'help', description: 'Show available commands' },
  { command: 'unlink', description: 'Unlink this Telegram account' },
] as const;

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
        const rendered =
          result.status === 'invalid_or_expired'
            ? renderRecoveryView(INVALID_TOKEN_MESSAGE, 'help')
            : renderLanding(result, 'Account linked successfully.');

        await replyView(context, rendered);
        return;
      }

      await replyView(
        context,
        renderLanding(await dependencies.backend.status(identity))
      );
    } catch (error: unknown) {
      logTransportFailure(log, identity.updateId, error);
      await replyView(context, renderTransportFailure(error, 'status'));
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
      await replyView(context, renderTransportFailure(error, 'status'));
    }
  });

  bot.command('help', async (context) => {
    if (!privateIdentity(context)) {
      return;
    }

    await replyView(context, renderHelp());
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
      await replyView(context, renderTransportFailure(error, 'settings'));
    }
  });

  bot.command('unlink', async (context) => {
    if (!privateIdentity(context)) {
      return;
    }

    await replyView(context, {
      text: 'Unlink this Telegram account? You will need a new token to link again.',
      keyboard: new InlineKeyboard()
        .text('Confirm Unlink', 'unlink:confirm')
        .row()
        .text('Home', NAVIGATION_CALLBACKS.home),
    });
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
      await replyView(context, renderTransportFailure(error, 'orders'));
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
      await replyView(context, renderTransportFailure(error, 'orders'));
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
              'Your Telegram account has been unlinked.',
              'help'
            )
          : renderRecoveryView('This chat is not authorized.', 'status')
      );
    } catch (error: unknown) {
      logTransportFailure(log, identity.updateId, error);
      await safeAnswerCallback(context);
      await replyView(context, renderTransportFailure(error, 'status'));
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
    await handleViewCallback(context, async () => renderHelp(), log);
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
          await context.reply(
            [
              result.purpose === 'TIMEZONE'
                ? 'Reply with a canonical IANA timezone, for example Asia/Tehran.'
                : 'Reply with a non-negative whole-number low-stock threshold.',
              '',
              `${SETTINGS_REFERENCE_LABEL} ${result.inputRef}`,
            ].join('\n'),
            {
              reply_markup: {
                force_reply: true,
                selective: true,
                input_field_placeholder:
                  result.purpose === 'TIMEZONE'
                    ? 'Asia/Tehran'
                    : 'Enter threshold',
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
          await context.reply(
            [
              `Reply to this message with the plain-text note (maximum ${result.maxLength} characters).`,
              '',
              `${NOTE_REFERENCE_LABEL} ${result.inputRef}`,
            ].join('\n'),
            {
              reply_markup: {
                force_reply: true,
                selective: true,
                input_field_placeholder: 'Enter order note',
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
  if (!isReadyStatus(status)) {
    const statusView = renderStatusView(status);

    return {
      text: notice ? `${notice}\n\n${statusView.text}` : statusView.text,
      keyboard: statusView.keyboard,
    };
  }

  return {
    text: [notice, 'WooCommerce Management', '', 'Choose an action.']
      .filter((line): line is string => line !== undefined)
      .join('\n'),
    keyboard: homeKeyboard(),
  };
}

function renderStatusView(status: TelegramAuthorizationStatus): RenderedView {
  const keyboard = new InlineKeyboard();

  if (isReadyStatus(status)) {
    keyboard.text('Recent Orders', NAVIGATION_CALLBACKS.orders).row();
  } else {
    keyboard.text('Help', NAVIGATION_CALLBACKS.help).row();
  }

  keyboard.text('Home', NAVIGATION_CALLBACKS.home);

  return {
    text: ['Account Status', '', renderStatus(status)].join('\n'),
    keyboard,
  };
}

function renderHelp(): RenderedView {
  return {
    text: [
      'Help',
      '',
      '/start — Open Home or link with a token',
      '/orders — Browse recent orders',
      '/order <number> — Open one exact order number',
      '/status — Check account and store access',
      '/settings — View or manage store settings',
      '/help — Show this command list',
      '/unlink — Unlink this Telegram account',
      '',
      'Order details, refresh, status changes, and permitted notes use the secure buttons shown by the bot.',
    ].join('\n'),
    keyboard: new InlineKeyboard()
      .text('Recent Orders', NAVIGATION_CALLBACKS.orders)
      .row()
      .text('Home', NAVIGATION_CALLBACKS.home),
  };
}

export function renderSettings(result: SettingsResult): RenderedView {
  if (result.state !== 'OK' || !result.settings) {
    return renderRecoveryView(
      settingsStateMessage(result.state),
      result.state === 'UNAUTHORIZED' || result.state === 'NO_ACTIVE_STORE'
        ? 'status'
        : 'settings'
    );
  }

  const settings = result.settings;
  const categories = settings.enabledNotificationCategories.map(
    notificationCategoryLabel
  );
  const recipients = settings.recipients
    .filter((recipient) => recipient.selected)
    .map(
      (recipient) =>
        `• ${recipient.displayName}${recipient.availability === 'UNAVAILABLE' ? ' — unavailable' : ''}`
    );
  const keyboard = new InlineKeyboard();

  if (settings.editable && settings.actions) {
    for (const language of settings.actions.languages) {
      keyboard.text(
        `${settings.language === language.language ? '✓ ' : ''}${language.language === 'FA' ? 'Persian' : 'English'}`,
        `sg:${language.ref}`
      );
    }

    keyboard
      .row()
      .text('Set Timezone', `si:${settings.actions.timezoneInputRef}`)
      .row()
      .text('Set Threshold', `si:${settings.actions.thresholdInputRef}`)
      .text('Clear Threshold', `sg:${settings.actions.thresholdClearRef}`);

    for (const category of settings.actions.categories) {
      keyboard
        .row()
        .text(
          `${category.enabled ? 'Disable' : 'Enable'} ${notificationCategoryLabel(category.category)}`,
          `sg:${category.enabled ? category.disableRef : category.enableRef}`
        );
    }

    for (const mode of settings.actions.recipientModes) {
      keyboard
        .row()
        .text(
          `${settings.recipientMode === mode.mode ? '✓ ' : ''}${recipientModeLabel(mode.mode)}`,
          `sg:${mode.ref}`
        );
    }

    for (const recipient of settings.recipients) {
      if (!recipient.actionRef || !recipient.action) {
        continue;
      }

      const action = recipient.action === 'SELECT' ? 'Select' : 'Remove';
      const availability =
        recipient.availability === 'UNAVAILABLE' ? ' (unavailable)' : '';
      const label = `${action} ${recipient.displayName}${availability}`;
      keyboard
        .row()
        .text(
          label.length <= 64 ? label : `${label.slice(0, 61)}...`,
          `sg:${recipient.actionRef}`
        );
    }
  }

  keyboard.row().text('Home', NAVIGATION_CALLBACKS.home);

  return {
    text: [
      'Store Settings',
      '',
      `Language: ${settings.language === 'FA' ? 'Persian' : 'English'}`,
      `Timezone: ${settings.timezone}`,
      `Low-stock threshold: ${settings.lowStockThreshold === null ? 'Not configured' : settings.lowStockThreshold}`,
      `Notifications: ${categories.length > 0 ? categories.join(', ') : 'None'}`,
      `Recipients: ${recipientModeLabel(settings.recipientMode)}`,
      `Selected: ${settings.selectedRecipientCount} • currently available: ${settings.availableRecipientCount}`,
      ...(recipients.length > 0
        ? ['', 'Selected managers', ...recipients]
        : []),
      ...(!settings.editable
        ? ['', 'Your membership has read-only access to settings.']
        : []),
    ].join('\n'),
    keyboard,
  };
}

function renderSettingsInputStart(
  result: SettingsInputStartResult
): RenderedView {
  if (result.state !== 'OK' || !result.purpose || !result.inputRef) {
    return renderRecoveryView(
      settingsStateMessage(result.state),
      result.state === 'UNAUTHORIZED' || result.state === 'NO_ACTIVE_STORE'
        ? 'status'
        : 'settings'
    );
  }

  return {
    text:
      result.purpose === 'TIMEZONE'
        ? 'Timezone entry is ready. Reply to the new prompt with a canonical IANA timezone.'
        : 'Threshold entry is ready. Reply to the new prompt with a non-negative whole number.',
    keyboard: new InlineKeyboard()
      .text('Back to Settings', NAVIGATION_CALLBACKS.settings)
      .row()
      .text('Home', NAVIGATION_CALLBACKS.home),
  };
}

function settingsStateMessage(state: SettingsResult['state']): string {
  switch (state) {
    case 'FORBIDDEN_ROLE':
      return 'Your membership can view settings but cannot change them.';
    case 'UNAUTHORIZED':
      return 'This chat is not authorized to view store settings.';
    case 'NO_ACTIVE_STORE':
      return NO_ACTIVE_STORE_MESSAGE;
    case 'INVALID_VALUE':
      return 'That setting value is invalid. Nothing changed. Reply to the original prompt again or reopen Settings.';
    case 'EXPIRED_REF':
      return 'This settings input expired or was already used. Nothing changed.';
    case 'CONTEXT_CHANGED':
      return 'This settings action expired or the active context changed. Nothing changed.';
    default:
      return 'Settings are unavailable. Return Home and try again.';
  }
}

function notificationCategoryLabel(
  category: 'ORDER_CREATED' | 'LOW_STOCK'
): string {
  return category === 'ORDER_CREATED' ? 'New order' : 'Low stock';
}

function recipientModeLabel(mode: SettingsSummary['recipientMode']): string {
  return mode === 'ALL_ELIGIBLE'
    ? 'All eligible managers'
    : 'Selected managers';
}

function renderRecoveryView(
  text: string,
  primary: 'orders' | 'status' | 'help' | 'settings'
): RenderedView {
  const labels = {
    orders: 'Refresh Recent Orders',
    status: 'Check Status',
    help: 'Help',
    settings: 'Settings',
  } as const;

  return {
    text,
    keyboard: new InlineKeyboard()
      .text(labels[primary], NAVIGATION_CALLBACKS[primary])
      .row()
      .text('Home', NAVIGATION_CALLBACKS.home),
  };
}

function renderTransportFailure(
  error: unknown,
  primary: 'orders' | 'status' | 'help' | 'settings' = 'help'
): RenderedView {
  return renderRecoveryView(transportFailureMessage(error), primary);
}

function homeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Recent Orders', NAVIGATION_CALLBACKS.orders)
    .row()
    .text('Settings', NAVIGATION_CALLBACKS.settings)
    .row()
    .text('Status', NAVIGATION_CALLBACKS.status)
    .text('Help', NAVIGATION_CALLBACKS.help);
}

function isReadyStatus(status: TelegramAuthorizationStatus): boolean {
  return Boolean(
    status.linked &&
    status.authorized &&
    !status.selectionRequired &&
    status.activeTenantId &&
    status.activeStoreId
  );
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

export function renderOrderList(result: OrderListResult): {
  text: string;
  keyboard: InlineKeyboard;
} {
  if (result.state === 'CONTEXT_CHANGED') {
    return renderRecoveryView(EXPIRED_LIST_MESSAGE, 'orders');
  }

  if (result.state === 'UNAUTHORIZED') {
    return renderRecoveryView(UNAUTHORIZED_ORDERS_MESSAGE, 'status');
  }

  if (result.state === 'NO_ACTIVE_STORE') {
    return renderRecoveryView(NO_ACTIVE_STORE_MESSAGE, 'status');
  }

  const keyboard = new InlineKeyboard();

  for (const order of result.orders) {
    keyboard.text(orderButtonLabel(order), order.ref).row();
  }

  if (result.previousCursor) {
    keyboard.text('Previous', result.previousCursor);
  }

  if (result.nextCursor) {
    keyboard.text('Next', result.nextCursor);
  }

  keyboard.row().text('Home', NAVIGATION_CALLBACKS.home);

  const text =
    result.orders.length === 0
      ? [
          'Recent Orders',
          '',
          'No recent orders are available yet.',
          'New orders will appear here after they are received.',
        ].join('\n')
      : [
          'Recent Orders',
          '',
          ...result.orders.map(
            (order) =>
              `#${order.orderNumber} • ${order.status} • ${order.total} ${order.currency}${order.remoteDeleted ? ' • deleted' : ''}`
          ),
          '',
          freshnessLine(result.freshness),
        ].join('\n');

  return { text, keyboard };
}

export function renderOrderDetail(result: OrderDetailResult): {
  text: string;
  keyboard: InlineKeyboard;
} {
  if (result.state === 'CONTEXT_CHANGED') {
    return renderRecoveryView(EXPIRED_LIST_MESSAGE, 'orders');
  }

  if (result.state === 'UNAUTHORIZED') {
    return renderRecoveryView(UNAUTHORIZED_ORDERS_MESSAGE, 'status');
  }

  if (result.state === 'NO_ACTIVE_STORE') {
    return renderRecoveryView(NO_ACTIVE_STORE_MESSAGE, 'status');
  }

  const keyboard = orderDetailKeyboard(
    result.backCursor,
    result.transitionsRef,
    result.refreshRef,
    result.addNoteRef
  );

  if (result.state === 'NOT_FOUND' || !result.order) {
    return {
      text: 'This order is no longer available. Return to Recent Orders to continue.',
      keyboard,
    };
  }

  if (result.state === 'DELETED' || result.order.remoteDeleted) {
    return {
      text: [
        `Order #${result.order.orderNumber}`,
        `Status: ${result.order.status}`,
        `Customer: ${result.order.customerDisplayName}`,
        'This order was deleted in WooCommerce.',
        freshnessLine(result.freshness),
      ].join('\n'),
      keyboard,
    };
  }

  return {
    text: renderActiveOrderDetail(result.order, result.freshness),
    keyboard,
  };
}

export function renderOrderLookup(result: OrderLookupResult): RenderedView {
  if (result.state === 'MALFORMED_ORDER_NUMBER') {
    return renderRecoveryView(
      'Use /order <number> with one exact order number, for example /order 1001.',
      'orders'
    );
  }

  if (result.state === 'AMBIGUOUS') {
    return renderRecoveryView(
      'A single exact order could not be identified. No order was opened.',
      'orders'
    );
  }

  return renderOrderDetail(result as OrderDetailResult);
}

export function renderOrderRefresh(result: OrderRefreshResult): RenderedView {
  if (result.state === 'OK' || result.state === 'DELETED') {
    const rendered = renderOrderDetail(result as OrderDetailResult);

    return {
      text: `Order refreshed from WooCommerce.\n\n${rendered.text}`,
      keyboard: rendered.keyboard,
    };
  }

  if (result.state === 'RETRYABLE') {
    return renderRecoveryView(
      'WooCommerce could not be reached to refresh this order. No repeated refresh was started.',
      'orders'
    );
  }

  if (result.state === 'FAILED') {
    return renderRecoveryView(
      'WooCommerce returned an invalid refresh result. The existing order projection was not replaced.',
      'orders'
    );
  }

  return renderOrderDetail(result as OrderDetailResult);
}

export function renderOrderNoteOptions(
  result: OrderNoteOptionsResult,
  detailRef: string
): RenderedView {
  if (result.state !== 'OK' || !result.ref || !result.visibilities) {
    return renderOrderNoteFailure(result.state, detailRef);
  }

  const keyboard = new InlineKeyboard();

  for (const visibility of result.visibilities) {
    keyboard
      .text(noteVisibilityLabel(visibility), `v:${result.ref}:${visibility}`)
      .row();
  }

  keyboard
    .text('Back to Order', detailRef)
    .row()
    .text('Home', NAVIGATION_CALLBACKS.home);

  return {
    text: [
      'Add Order Note',
      '',
      'Internal notes are visible to store staff only.',
      'Customer-visible notes use WooCommerce customer-note delivery behavior.',
      '',
      'Choose visibility:',
    ].join('\n'),
    keyboard,
  };
}

export function renderOrderNoteStart(
  result: OrderNoteStartResult
): RenderedView {
  if (
    result.state !== 'OK' ||
    !result.inputRef ||
    !result.detailRef ||
    !result.visibility
  ) {
    return renderOrderNoteFailure(result.state, result.detailRef);
  }

  return {
    text: [
      'Add Order Note',
      '',
      `Visibility: ${noteVisibilityLabel(result.visibility)}`,
      'Reply to the prompt with plain text. You will review it before anything is sent to WooCommerce.',
    ].join('\n'),
    keyboard: new InlineKeyboard()
      .text('Cancel', `x:${result.inputRef}`)
      .row()
      .text('Back to Order', result.detailRef)
      .row()
      .text('Home', NAVIGATION_CALLBACKS.home),
  };
}

export function renderOrderNotePrepare(
  result: OrderNotePrepareResult,
  inputRef: string
): RenderedView {
  if (
    result.state !== 'OK' ||
    !result.confirmRef ||
    !result.detailRef ||
    !result.visibility ||
    result.preview === undefined
  ) {
    if (result.state === 'INVALID_NOTE') {
      return {
        text: 'The note must be non-empty plain text, at most 1,000 characters, without HTML markup or control characters. No note was created.',
        keyboard: new InlineKeyboard()
          .text('Cancel', `x:${inputRef}`)
          .row()
          .text('Home', NAVIGATION_CALLBACKS.home),
      };
    }

    return renderOrderNoteFailure(result.state, result.detailRef);
  }

  return {
    text: [
      'Confirm Order Note',
      '',
      `Visibility: ${noteVisibilityLabel(result.visibility)}`,
      `Preview: ${result.preview}`,
      '',
      'Confirming creates one WooCommerce note. This action cannot be edited or deleted here.',
    ].join('\n'),
    keyboard: new InlineKeyboard()
      .text('Confirm', `nc:${result.confirmRef}`)
      .text('Cancel', `x:${result.confirmRef}`)
      .row()
      .text('Back to Order', result.detailRef)
      .row()
      .text('Home', NAVIGATION_CALLBACKS.home),
  };
}

export function renderOrderNoteMutation(
  result: OrderNoteMutationResult
): RenderedView {
  const keyboard = new InlineKeyboard();

  if (result.detailRef) {
    keyboard.text('Back to Order', result.detailRef).row();
  } else {
    keyboard.text('Recent Orders', NAVIGATION_CALLBACKS.orders).row();
  }

  keyboard.text('Home', NAVIGATION_CALLBACKS.home);

  return {
    text: orderNoteStateMessage(result),
    keyboard,
  };
}

export function renderOrderTransitions(
  result: OrderTransitionsResult,
  detailRef: string
): { text: string; keyboard: InlineKeyboard } {
  if (result.state !== 'OK' || !result.ref || !result.targets) {
    if (result.state === 'CONTEXT_CHANGED') {
      return renderRecoveryView(EXPIRED_LIST_MESSAGE, 'orders');
    }

    if (result.state === 'UNAUTHORIZED') {
      return renderRecoveryView(UNAUTHORIZED_ORDERS_MESSAGE, 'status');
    }

    if (result.state === 'NO_ACTIVE_STORE') {
      return renderRecoveryView(NO_ACTIVE_STORE_MESSAGE, 'status');
    }

    if (result.state === 'NOT_FOUND' || result.state === 'DELETED') {
      return renderRecoveryView(orderWriteStateMessage(result.state), 'orders');
    }

    return {
      text: orderWriteStateMessage(result.state),
      keyboard: new InlineKeyboard()
        .text('Back to Order', detailRef)
        .row()
        .text('Home', NAVIGATION_CALLBACKS.home),
    };
  }

  const keyboard = new InlineKeyboard();

  for (const target of result.targets) {
    keyboard.text(statusLabel(target), `${result.ref}:${target}`).row();
  }

  keyboard
    .text('Back to Order', detailRef)
    .row()
    .text('Home', NAVIGATION_CALLBACKS.home);

  return {
    text:
      result.targets.length === 0
        ? `No supported status changes are available from ${statusLabel(result.currentStatus ?? 'the current status')}.`
        : `Change Status\n\nCurrent status: ${statusLabel(result.currentStatus ?? 'the current status')}\nChoose the new status:`,
    keyboard,
  };
}

export function renderOrderStatusUpdate(result: OrderStatusUpdateResult): {
  text: string;
  keyboard: InlineKeyboard;
} {
  if (result.order && result.freshness) {
    const completed = result.state === 'OK' || result.state === 'NO_OP';
    const rendered = renderOrderDetail({
      state: 'OK',
      order: result.order,
      ...(completed && result.backCursor
        ? { backCursor: result.backCursor }
        : {}),
      freshness: result.freshness,
    });

    return {
      text: `${
        result.state === 'OK'
          ? 'Status updated successfully.'
          : result.state === 'NO_OP'
            ? 'The order already has that status.'
            : orderWriteStateMessage(result.state)
      }\n\n${rendered.text}`,
      keyboard: rendered.keyboard,
    };
  }

  if (result.state === 'UNAUTHORIZED' || result.state === 'NO_ACTIVE_STORE') {
    return renderRecoveryView(orderWriteStateMessage(result.state), 'status');
  }

  return renderRecoveryView(orderWriteStateMessage(result.state), 'orders');
}

function orderWriteStateMessage(
  state: OrderTransitionsResult['state'] | OrderStatusUpdateResult['state']
): string {
  switch (state) {
    case 'FORBIDDEN_ROLE':
      return 'Your membership can view orders but cannot change their status.';
    case 'UNAUTHORIZED':
      return UNAUTHORIZED_ORDERS_MESSAGE;
    case 'NO_ACTIVE_STORE':
      return NO_ACTIVE_STORE_MESSAGE;
    case 'CONTEXT_CHANGED':
      return EXPIRED_LIST_MESSAGE;
    case 'EXPIRED_REF':
      return 'This status action expired. No change was made. Refresh Recent Orders and open the order again.';
    case 'INVALID_TARGET':
      return 'That status is no longer available for this order. No change was made.';
    case 'RETRYABLE':
      return 'WooCommerce could not confirm the change. Refresh Recent Orders and verify the current status before trying again.';
    case 'FAILED':
      return 'WooCommerce did not accept the status change. Refresh Recent Orders to continue.';
    case 'DELETED':
      return 'This order was deleted in WooCommerce.';
    case 'NOT_FOUND':
      return 'This order is no longer available.';
    default:
      return 'No status change is available.';
  }
}

function renderOrderNoteFailure(
  state: OrderNoteMutationResult['state'],
  detailRef?: string
): RenderedView {
  const keyboard = new InlineKeyboard();

  if (detailRef) {
    keyboard.text('Back to Order', detailRef).row();
  } else {
    keyboard.text('Recent Orders', NAVIGATION_CALLBACKS.orders).row();
  }

  keyboard.text('Home', NAVIGATION_CALLBACKS.home);

  return { text: orderNoteStateMessage({ state }), keyboard };
}

function orderNoteStateMessage(result: OrderNoteMutationResult): string {
  switch (result.state) {
    case 'OK':
      return `The ${noteVisibilityLabel(result.visibility ?? 'INTERNAL').toLowerCase()} note was created once in WooCommerce${result.orderNumber ? ` for order #${result.orderNumber}` : ''}.`;
    case 'CANCELLED':
      return 'Note creation was cancelled. Nothing was sent to WooCommerce.';
    case 'FORBIDDEN_ROLE':
      return 'Your membership can view orders but cannot create order notes.';
    case 'UNAUTHORIZED':
      return UNAUTHORIZED_ORDERS_MESSAGE;
    case 'NO_ACTIVE_STORE':
      return NO_ACTIVE_STORE_MESSAGE;
    case 'CONTEXT_CHANGED':
      return EXPIRED_LIST_MESSAGE;
    case 'EXPIRED_REF':
      return 'This note action expired. No note was created.';
    case 'INVALID_NOTE':
      return 'The note text is invalid. No note was created.';
    case 'IN_PROGRESS':
      return 'This note action is already being processed. It was not dispatched again.';
    case 'AMBIGUOUS':
      return 'WooCommerce may have received this note, but the result could not be confirmed. It will not be sent again automatically.';
    case 'RETRYABLE':
      return 'WooCommerce safely rejected or deferred this note request. It was not sent again; start a new note action if needed.';
    case 'DELETED':
      return 'This order was deleted in WooCommerce. No note was created.';
    case 'NOT_FOUND':
      return 'This order is no longer available. No note was created.';
    default:
      return 'WooCommerce did not create the note. It was not sent again.';
  }
}

function noteVisibilityLabel(visibility: OrderNoteVisibility): string {
  return visibility === 'CUSTOMER' ? 'Customer-visible' : 'Internal';
}

function orderDetailKeyboard(
  backCursor?: string,
  transitionsRef?: string,
  refreshRef?: string,
  addNoteRef?: string
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (backCursor) {
    keyboard.text('Back to Orders', backCursor);
  } else {
    keyboard.text('Recent Orders', NAVIGATION_CALLBACKS.orders);
  }

  if (transitionsRef) {
    keyboard.row().text('Change Status', `t:${transitionsRef}`);
  }

  if (refreshRef) {
    keyboard.row().text('Refresh', `r:${refreshRef}`);
  }

  if (addNoteRef) {
    keyboard.row().text('Add Note', `n:${addNoteRef}`);
  }

  keyboard.row().text('Home', NAVIGATION_CALLBACKS.home);
  return keyboard;
}

function noteInputReference(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  const match = text.match(
    /(?:^|\n)Note reference: (i\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16})(?:\n|$)/
  );

  return match?.[1];
}

function settingsInputReference(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  const match = text.match(
    /(?:^|\n)Settings reference: (g\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16})(?:\n|$)/
  );

  return match?.[1];
}

function statusLabel(status: string): string {
  const words = status.replace(/-/g, ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

async function handleViewCallback(
  context: Context,
  render: (identity: TelegramIdentity) => Promise<RenderedView>,
  log: (record: Readonly<Record<string, unknown>>) => void,
  recovery: 'orders' | 'status' | 'help' | 'settings' = 'help'
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
  freshness: OrderDetailResult['freshness']
): string {
  const total = order.totals?.['total'];
  const lines = (order.lineItems ?? []).map(
    (item) => `• ${item.name} × ${String(item.quantity)} — ${item.total}`
  );
  const payment = order.payment
    ? `Payment: ${order.payment.method ?? 'Not specified'} • ${order.payment.paid ? 'Paid' : 'Unpaid'}`
    : undefined;
  const shippingMethods = order.shipping?.methods.join(', ');
  const shippingAddress = order.shipping?.addressLines.join(' • ');

  return [
    `Order #${order.orderNumber}`,
    `Status: ${order.status}`,
    `Customer: ${order.customerDisplayName}`,
    `Total: ${total === undefined ? '—' : String(total)} ${order.currency ?? ''}`.trim(),
    ...(payment ? [payment] : []),
    ...(shippingMethods ? [`Shipping: ${shippingMethods}`] : []),
    ...(shippingAddress ? [`Ship to: ${shippingAddress}`] : []),
    `Created: ${order.wcCreatedAt ?? '—'}`,
    `Modified: ${order.wcModifiedAt ?? '—'}`,
    ...(lines.length > 0 ? ['', 'Items', ...lines] : []),
    '',
    freshnessLine(freshness),
  ].join('\n');
}

function freshnessLine(freshness: OrderListResult['freshness']): string {
  return `Last updated ${freshness.asOf}${freshness.delayed ? ' • delayed' : ''}`;
}

function orderButtonLabel(order: OrderSummary): string {
  const label = `#${order.orderNumber} • ${order.status} • ${order.total} ${order.currency}`;

  return label.length <= 64 ? label : `${label.slice(0, 61)}...`;
}

function transportFailureMessage(error: unknown): string {
  return error?.constructor?.name === 'MalformedBackendResponseError'
    ? MALFORMED_RESPONSE_MESSAGE
    : TRANSIENT_FAILURE_MESSAGE;
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
  privateOnly: PRIVATE_ONLY_MESSAGE,
  transientFailure: TRANSIENT_FAILURE_MESSAGE,
  invalidToken: INVALID_TOKEN_MESSAGE,
  expiredList: EXPIRED_LIST_MESSAGE,
  unauthorizedOrders: UNAUTHORIZED_ORDERS_MESSAGE,
  noActiveStore: NO_ACTIVE_STORE_MESSAGE,
  malformedResponse: MALFORMED_RESPONSE_MESSAGE,
} as const;
