const assert = require('node:assert/strict');
const { test } = require('node:test');

const { BOT_COMMANDS, BOT_MESSAGES, createBot } = require('../dist/bot');

const BOT_TOKEN = '1234567890:test-token-value-for-adapter';
const DETAIL_REF = `d.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const WRITE_REF = `s.${'c'.repeat(16)}.${'d'.repeat(16)}`;
const BACK_CURSOR = `p.${'e'.repeat(16)}.${'f'.repeat(16)}`;
const FRESHNESS = {
  asOf: '2026-08-28T09:00:00.000Z',
  delayed: false,
};

test('Home, Recent Orders, order detail, and Back reuse existing stateless endpoints', async () => {
  const backendCalls = [];
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      status: async () => {
        backendCalls.push({ operation: 'status' });
        return readyStatus();
      },
      listOrders: async (_identity, cursor) => {
        backendCalls.push({ operation: 'list', cursor });
        return orderList();
      },
      orderDetail: async (_identity, ref) => {
        backendCalls.push({ operation: 'detail', ref });
        return orderDetail();
      },
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(privateCommandUpdate(100, '/start'));
  await bot.handleUpdate(callbackUpdate(101, 'nav:orders'));
  await bot.handleUpdate(callbackUpdate(102, DETAIL_REF, 'New Order'));
  await bot.handleUpdate(callbackUpdate(103, BACK_CURSOR, 'Order Detail'));
  await bot.handleUpdate(callbackUpdate(104, 'nav:home'));

  assert.deepEqual(backendCalls, [
    { operation: 'status' },
    { operation: 'list', cursor: undefined },
    { operation: 'detail', ref: DETAIL_REF },
    { operation: 'list', cursor: BACK_CURSOR },
    { operation: 'status' },
  ]);

  const home = apiCalls.find((call) => call.method === 'sendMessage');
  assert.match(home.payload.text, /WooCommerce Management/);
  assert.deepEqual(callbacks(home), [
    'nav:orders',
    'nav:stock',
    'nav:settings',
    'nav:status',
    'nav:help',
  ]);

  const detailEdit = apiCalls
    .filter((call) => call.method === 'editMessageText')
    .find((call) => call.payload.text.includes('Order #1001'));
  assert.deepEqual(callbacks(detailEdit), [
    BACK_CURSOR,
    `t:${DETAIL_REF}`,
    'nav:home',
  ]);
});

test('/status and /orders expose coherent navigation and recovery actions', async () => {
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      status: async () => readyStatus(),
      listOrders: async () => orderList(),
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(privateCommandUpdate(110, '/status'));
  await bot.handleUpdate(privateCommandUpdate(111, '/orders'));

  const messages = apiCalls.filter((call) => call.method === 'sendMessage');
  assert.match(messages[0].payload.text, /Account Status/);
  assert.deepEqual(callbacks(messages[0]), ['nav:orders', 'nav:home']);
  assert.match(messages[1].payload.text, /Recent Orders/);
  assert.ok(callbacks(messages[1]).includes('nav:home'));
});

test('empty order lists explain what happens next and retain Home', async () => {
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      listOrders: async () =>
        orderList({ orders: [], nextCursor: null, previousCursor: null }),
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(privateCommandUpdate(120, '/orders'));

  const message = apiCalls.find((call) => call.method === 'sendMessage');
  assert.match(message.payload.text, /No recent orders are available yet/);
  assert.match(message.payload.text, /New orders will appear here/);
  assert.deepEqual(callbacks(message), ['nav:home']);
});

test('expired or context-changed list, detail, and status screens require fresh navigation', async () => {
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      listOrders: async () =>
        orderList({
          state: 'CONTEXT_CHANGED',
          orders: [],
          nextCursor: null,
          previousCursor: null,
        }),
      orderDetail: async () => ({
        state: 'CONTEXT_CHANGED',
        freshness: FRESHNESS,
      }),
      orderTransitions: async () => ({ state: 'CONTEXT_CHANGED' }),
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(callbackUpdate(130, BACK_CURSOR));
  await bot.handleUpdate(callbackUpdate(131, DETAIL_REF));
  await bot.handleUpdate(callbackUpdate(132, `t:${DETAIL_REF}`));

  const edits = apiCalls.filter((call) => call.method === 'editMessageText');
  assert.equal(edits.length, 3);
  for (const edit of edits) {
    assert.equal(edit.payload.text, BOT_MESSAGES.expiredList);
    assert.deepEqual(callbacks(edit), ['nav:orders', 'nav:home']);
    assert.ok(!callbacks(edit).includes(DETAIL_REF));
    assert.ok(!callbacks(edit).includes(BACK_CURSOR));
  }
});

test('M13 notification callbacks continue through M11 detail and M12 status without new state', async () => {
  const backendCalls = [];
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      orderDetail: async (_identity, ref) => {
        backendCalls.push({ operation: 'detail', ref });
        return orderDetail();
      },
      orderTransitions: async (_identity, ref) => {
        backendCalls.push({ operation: 'transitions', ref });
        return {
          state: 'OK',
          ref: WRITE_REF,
          currentStatus: 'processing',
          targets: ['completed'],
        };
      },
      updateOrderStatus: async (_identity, ref, target) => {
        backendCalls.push({ operation: 'status', ref, target });
        return {
          state: 'OK',
          order: { ...orderDetail().order, status: 'completed' },
          backCursor: BACK_CURSOR,
          freshness: FRESHNESS,
        };
      },
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(callbackUpdate(140, DETAIL_REF, 'New Order'));
  await bot.handleUpdate(callbackUpdate(141, `t:${DETAIL_REF}`));
  await bot.handleUpdate(callbackUpdate(142, `${WRITE_REF}:completed`));

  assert.deepEqual(backendCalls, [
    { operation: 'detail', ref: DETAIL_REF },
    { operation: 'transitions', ref: DETAIL_REF },
    { operation: 'status', ref: WRITE_REF, target: 'completed' },
  ]);
  const edits = apiCalls.filter((call) => call.method === 'editMessageText');
  assert.ok(callbacks(edits[0]).includes(`t:${DETAIL_REF}`));
  assert.ok(callbacks(edits[1]).includes(`${WRITE_REF}:completed`));
  assert.match(edits[2].payload.text, /Status updated successfully/);
  assert.match(edits[2].payload.text, /Status: completed/);
  assert.deepEqual(callbacks(edits[2]), [BACK_CURSOR, 'nav:home']);
});

test('status-result failures preserve safe snapshots and provide fresh recovery', async () => {
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      updateOrderStatus: async (_identity, _ref, target) =>
        target === 'completed'
          ? {
              state: 'EXPIRED_REF',
              order: orderDetail().order,
              backCursor: BACK_CURSOR,
              freshness: FRESHNESS,
            }
          : { state: 'RETRYABLE' },
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(callbackUpdate(150, `${WRITE_REF}:completed`));
  await bot.handleUpdate(callbackUpdate(151, `${WRITE_REF}:on-hold`));

  const edits = apiCalls.filter((call) => call.method === 'editMessageText');
  assert.match(edits[0].payload.text, /status action expired/i);
  assert.match(edits[0].payload.text, /Order #1001/);
  assert.deepEqual(callbacks(edits[0]), ['nav:orders', 'nav:home']);
  assert.ok(!callbacks(edits[0]).some((value) => value.startsWith('t:')));
  assert.match(edits[1].payload.text, /could not confirm/);
  assert.deepEqual(callbacks(edits[1]), ['nav:orders', 'nav:home']);
});

test('/help and command discovery list existing functionality only', async () => {
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, { backend: {} });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(privateCommandUpdate(160, '/help'));

  assert.deepEqual(
    BOT_COMMANDS.map(({ command }) => command),
    [
      'start',
      'orders',
      'order',
      'status',
      'settings',
      'stock',
      'help',
      'unlink',
    ]
  );
  const message = apiCalls.find((call) => call.method === 'sendMessage');
  for (const command of BOT_COMMANDS) {
    assert.match(message.payload.text, new RegExp(`/${command.command}`));
  }
  assert.doesNotMatch(message.payload.text, /search|analytics|billing/i);
  assert.deepEqual(callbacks(message), [
    'nav:orders',
    'nav:stock',
    'nav:home',
  ]);
});

test('M14 navigation edit failures fall back to one reply with the same actions', async () => {
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: { status: async () => readyStatus() },
  });
  installApiStub(bot, apiCalls, { failEdits: true });

  await bot.handleUpdate(callbackUpdate(170, 'nav:home'));

  assert.equal(
    apiCalls.filter((call) => call.method === 'editMessageText').length,
    1
  );
  const reply = apiCalls.find((call) => call.method === 'sendMessage');
  assert.match(reply.payload.text, /WooCommerce Management/);
  assert.deepEqual(callbacks(reply), [
    'nav:orders',
    'nav:stock',
    'nav:settings',
    'nav:status',
    'nav:help',
  ]);
});

function readyStatus() {
  return {
    linked: true,
    authorized: true,
    membershipState: 'active',
    activeTenantId: 'ten_a',
    activeStoreId: 'sto_a',
    tenantSelectionRequired: false,
    storeSelectionRequired: false,
    selectionRequired: false,
  };
}

function orderList(overrides = {}) {
  return {
    state: 'OK',
    orders: [
      {
        ref: DETAIL_REF,
        orderNumber: '1001',
        status: 'processing',
        currency: 'IRR',
        total: '120000',
        customerDisplayName: 'Test Customer',
        wcCreatedAt: '2026-08-28T08:00:00.000Z',
        remoteDeleted: false,
      },
    ],
    nextCursor: null,
    previousCursor: null,
    freshness: FRESHNESS,
    ...overrides,
  };
}

function orderDetail() {
  return {
    state: 'OK',
    order: {
      orderNumber: '1001',
      status: 'processing',
      currency: 'IRR',
      totals: { total: '120000' },
      customerDisplayName: 'Test Customer',
      lineItems: [{ name: 'Widget', quantity: 2, total: '120000' }],
      wcCreatedAt: '2026-08-28T08:00:00.000Z',
      wcModifiedAt: '2026-08-28T09:00:00.000Z',
      remoteDeleted: false,
    },
    backCursor: BACK_CURSOR,
    transitionsRef: DETAIL_REF,
    freshness: FRESHNESS,
  };
}

function privateCommandUpdate(updateId, text) {
  const commandLength = text.includes(' ') ? text.indexOf(' ') : text.length;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 1001, type: 'private', first_name: 'Test' },
      from: { id: 1001, is_bot: false, first_name: 'Test' },
      text,
      entities: [{ offset: 0, length: commandLength, type: 'bot_command' }],
    },
  };
}

function callbackUpdate(updateId, data, text = 'Management') {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      chat_instance: 'instance-1',
      from: { id: 1001, is_bot: false, first_name: 'Test' },
      data,
      message: {
        message_id: 2,
        date: 1,
        chat: { id: 1001, type: 'private', first_name: 'Test' },
        text,
      },
    },
  };
}

function callbacks(call) {
  return call.payload.reply_markup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
}

function installApiStub(bot, calls, options = {}) {
  bot.botInfo = {
    id: 1234567890,
    is_bot: true,
    first_name: 'WC Telegram Test Bot',
    username: 'wc_telegram_test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload });

    if (method === 'editMessageText' && options.failEdits) {
      return {
        ok: false,
        error_code: 400,
        description: 'message cannot be edited',
      };
    }

    if (
      method === 'answerCallbackQuery' ||
      method === 'editMessageReplyMarkup'
    ) {
      return { ok: true, result: true };
    }

    return {
      ok: true,
      result: {
        message_id: 999,
        date: 1,
        chat: { id: Number(payload.chat_id ?? 1001), type: 'private' },
        text: payload.text ?? '',
      },
    };
  });
}
