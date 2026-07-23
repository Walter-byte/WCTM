import { Bot, InlineKeyboard, type Context } from 'grammy';

import { InternalBackendClient } from './internal-backend.client';
import type {
  OrderDetailPayload,
  OrderDetailResult,
  OrderListResult,
  OrderSummary,
} from './internal-backend.client';
import { UpdateDeduplicator } from './update-deduplicator';

const PRIVATE_ONLY_MESSAGE =
  'This bot can only be used in a private Telegram chat.';
const TRANSIENT_FAILURE_MESSAGE =
  'The service is temporarily unavailable. Please try again.';
const INVALID_TOKEN_MESSAGE =
  'This link token is invalid or expired. Request a new token and try again.';
const EXPIRED_LIST_MESSAGE = 'This order list expired. Send /orders again.';
const UNAUTHORIZED_ORDERS_MESSAGE =
  'This chat is not authorized to view orders.';
const NO_ACTIVE_STORE_MESSAGE =
  'No single active store is available for this chat.';
const MALFORMED_RESPONSE_MESSAGE =
  'The service returned an unexpected response. Please try again.';

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

  bot.command('orders', async (context) => {
    const identity = privateIdentity(context);

    if (!identity) {
      return;
    }

    try {
      const result = await dependencies.backend.listOrders(identity);
      const rendered = renderOrderList(result);

      await context.reply(rendered.text, {
        reply_markup: rendered.keyboard,
      });
    } catch (error: unknown) {
      logTransportFailure(log, identity.updateId, error);
      await context.reply(transportFailureMessage(error));
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
        await context.reply(transportFailureMessage(error));
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
        await context.reply(transportFailureMessage(error));
      }
    }
  );

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

export function renderOrderList(result: OrderListResult): {
  text: string;
  keyboard: InlineKeyboard;
} {
  if (result.state === 'CONTEXT_CHANGED') {
    return { text: EXPIRED_LIST_MESSAGE, keyboard: new InlineKeyboard() };
  }

  if (result.state === 'UNAUTHORIZED') {
    return {
      text: UNAUTHORIZED_ORDERS_MESSAGE,
      keyboard: new InlineKeyboard(),
    };
  }

  if (result.state === 'NO_ACTIVE_STORE') {
    return { text: NO_ACTIVE_STORE_MESSAGE, keyboard: new InlineKeyboard() };
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

  const text =
    result.orders.length === 0
      ? 'No projected orders are available.'
      : [
          'Recent orders',
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
  const keyboard = new InlineKeyboard();

  if (result.backCursor) {
    keyboard.text('Back to orders', result.backCursor);
  }

  if (result.state === 'CONTEXT_CHANGED') {
    return { text: EXPIRED_LIST_MESSAGE, keyboard: new InlineKeyboard() };
  }

  if (result.state === 'UNAUTHORIZED') {
    return {
      text: UNAUTHORIZED_ORDERS_MESSAGE,
      keyboard: new InlineKeyboard(),
    };
  }

  if (result.state === 'NO_ACTIVE_STORE') {
    return { text: NO_ACTIVE_STORE_MESSAGE, keyboard: new InlineKeyboard() };
  }

  if (result.state === 'NOT_FOUND' || !result.order) {
    return { text: 'This order is no longer available.', keyboard };
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
    // Callback acknowledgement failure is harmless for read-only actions.
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

  return [
    `Order #${order.orderNumber}`,
    `Status: ${order.status}`,
    `Customer: ${order.customerDisplayName}`,
    `Total: ${total === undefined ? '—' : String(total)} ${order.currency ?? ''}`.trim(),
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
