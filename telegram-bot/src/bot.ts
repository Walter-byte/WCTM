import { Bot, InlineKeyboard, type Context } from 'grammy';

import { InternalBackendClient } from './internal-backend.client';
import type {
  OrderDetailPayload,
  OrderDetailResult,
  OrderListResult,
  OrderStatusUpdateResult,
  OrderSummary,
  OrderTransitionsResult,
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

const NAVIGATION_CALLBACKS = {
  home: 'nav:home',
  orders: 'nav:orders',
  status: 'nav:status',
  help: 'nav:help',
} as const;

export const BOT_COMMANDS = [
  { command: 'start', description: 'Open Home or link your account' },
  { command: 'orders', description: 'Open recent orders' },
  { command: 'status', description: 'Check account and store access' },
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
      '/status — Check account and store access',
      '/help — Show this command list',
      '/unlink — Unlink this Telegram account',
      '',
      'Order details and status actions are available only through the secure buttons shown by the bot.',
    ].join('\n'),
    keyboard: new InlineKeyboard()
      .text('Recent Orders', NAVIGATION_CALLBACKS.orders)
      .row()
      .text('Home', NAVIGATION_CALLBACKS.home),
  };
}

function renderRecoveryView(
  text: string,
  primary: 'orders' | 'status' | 'help'
): RenderedView {
  const labels = {
    orders: 'Refresh Recent Orders',
    status: 'Check Status',
    help: 'Help',
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
  primary: 'orders' | 'status' | 'help' = 'help'
): RenderedView {
  return renderRecoveryView(transportFailureMessage(error), primary);
}

function homeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Recent Orders', NAVIGATION_CALLBACKS.orders)
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
    result.transitionsRef
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

function orderDetailKeyboard(
  backCursor?: string,
  transitionsRef?: string
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

  keyboard.row().text('Home', NAVIGATION_CALLBACKS.home);
  return keyboard;
}

function statusLabel(status: string): string {
  const words = status.replace(/-/g, ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

async function handleViewCallback(
  context: Context,
  render: (identity: TelegramIdentity) => Promise<RenderedView>,
  log: (record: Readonly<Record<string, unknown>>) => void,
  recovery: 'orders' | 'status' | 'help' = 'help'
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
