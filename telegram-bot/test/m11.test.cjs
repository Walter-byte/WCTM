const assert = require('node:assert/strict');
const { test } = require('node:test');

const { BOT_MESSAGES, createBot } = require('../dist/bot');
const {
  BackendUnavailableError,
  InternalBackendClient,
  MalformedBackendResponseError,
} = require('../dist/internal-backend.client');

const BOT_TOKEN = '1234567890:test-token-value-for-adapter';
const DETAIL_REF = `d.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const NEXT_CURSOR = `p.${'c'.repeat(16)}.${'d'.repeat(16)}`;
const BACK_CURSOR = `p.${'e'.repeat(16)}.${'f'.repeat(16)}`;
const FRESHNESS = {
  asOf: '2026-07-23T12:10:00.000Z',
  delayed: false,
};

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
        wcCreatedAt: '2026-07-23T12:00:00.000Z',
        remoteDeleted: false,
      },
    ],
    nextCursor: NEXT_CURSOR,
    previousCursor: null,
    freshness: FRESHNESS,
    ...overrides,
  };
}

test('/orders renders backend summaries and opaque inline references', async () => {
  const calls = [];
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      listOrders: async (identity, cursor) => {
        calls.push({ identity, cursor });
        return orderList();
      },
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(privateCommandUpdate(100, '/orders'));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cursor, undefined);
  const message = apiCalls.find((call) => call.method === 'sendMessage');
  assert.match(
    message.payload.text,
    /#\u20681001\u2069 • Processing • IRR\s?120,000/
  );
  const callbackData = message.payload.reply_markup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  assert.ok(callbackData.includes(DETAIL_REF));
  assert.ok(callbackData.includes(NEXT_CURSOR));
  assert.ok(callbackData.every((value) => value.length <= 64));
});

test('pagination and detail callbacks call only their matching backend endpoints', async () => {
  const listCalls = [];
  const detailCalls = [];
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      listOrders: async (identity, cursor) => {
        listCalls.push({ identity, cursor });
        return orderList({ nextCursor: null, previousCursor: BACK_CURSOR });
      },
      orderDetail: async (identity, ref) => {
        detailCalls.push({ identity, ref });
        return {
          state: 'OK',
          order: {
            orderNumber: '1001',
            status: 'processing',
            currency: 'IRR',
            totals: { total: '120000' },
            customerDisplayName: 'Test Customer',
            lineItems: [{ name: 'Widget', quantity: 2, total: '120000' }],
            wcCreatedAt: '2026-07-23T12:00:00.000Z',
            wcModifiedAt: '2026-07-23T12:05:00.000Z',
            remoteDeleted: false,
          },
          backCursor: BACK_CURSOR,
          freshness: FRESHNESS,
        };
      },
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(callbackUpdate(101, NEXT_CURSOR));
  await bot.handleUpdate(callbackUpdate(102, DETAIL_REF));

  assert.equal(listCalls.length, 1);
  assert.equal(listCalls[0].cursor, NEXT_CURSOR);
  assert.equal(detailCalls.length, 1);
  assert.equal(detailCalls[0].ref, DETAIL_REF);
  const edits = apiCalls.filter((call) => call.method === 'editMessageText');
  assert.equal(edits.length, 2);
  assert.match(edits[1].payload.text, /Widget × 2/);
  assert.equal(
    edits[1].payload.reply_markup.inline_keyboard[0][0].callback_data,
    BACK_CURSOR
  );
});

test('expired pagination and detail references render a safe renewal notice', async () => {
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      listOrders: async () =>
        orderList({
          state: 'CONTEXT_CHANGED',
          orders: [],
          nextCursor: null,
        }),
      orderDetail: async () => ({
        state: 'CONTEXT_CHANGED',
        freshness: FRESHNESS,
      }),
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(callbackUpdate(103, NEXT_CURSOR));
  await bot.handleUpdate(callbackUpdate(104, DETAIL_REF));

  const notices = apiCalls
    .filter((call) => call.method === 'editMessageText')
    .map((call) => call.payload.text);
  assert.deepEqual(notices, [
    BOT_MESSAGES.expiredList,
    BOT_MESSAGES.expiredList,
  ]);
});

test('order callbacks are deduplicated and an edit failure falls back to a new message', async () => {
  const calls = [];
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      listOrders: async () => {
        calls.push('list');
        return orderList();
      },
    },
  });
  installApiStub(bot, apiCalls, { failEdits: true });
  const update = callbackUpdate(105, NEXT_CURSOR);

  await bot.handleUpdate(update);
  await bot.handleUpdate(update);

  assert.equal(calls.length, 1);
  assert.equal(
    apiCalls.filter((call) => call.method === 'editMessageText').length,
    1
  );
  assert.equal(
    apiCalls.filter((call) => call.method === 'sendMessage').length,
    1
  );
});

test('group /orders is rejected without backend access', async () => {
  const calls = [];
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      listOrders: async () => {
        calls.push('list');
        return orderList();
      },
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate({
    update_id: 106,
    message: {
      message_id: 106,
      date: 1,
      chat: { id: -1001, type: 'group', title: 'Group' },
      from: { id: 1001, is_bot: false, first_name: 'Test' },
      text: '/orders',
      entities: [{ offset: 0, length: 7, type: 'bot_command' }],
    },
  });

  assert.equal(calls.length, 0);
  assert.equal(
    apiCalls.find((call) => call.method === 'sendMessage').payload.text,
    BOT_MESSAGES.privateOnly
  );
});

test('internal client sends nested Telegram identity and validates order responses', async () => {
  const observed = [];
  const request = async (url, init) => {
    observed.push({ url, init });
    return {
      ok: true,
      json: async () =>
        url.endsWith('/orders/list')
          ? orderList()
          : {
              state: 'DELETED',
              order: {
                orderNumber: '1001',
                status: 'trash',
                customerDisplayName: 'Test Customer',
                remoteDeleted: true,
              },
              backCursor: BACK_CURSOR,
              freshness: FRESHNESS,
            },
    };
  };
  const client = new InternalBackendClient(
    {
      internalApiKey: 'internal-secret',
      backendInternalUrl: 'http://backend:3000/api',
      backendTimeoutMs: 5000,
    },
    request
  );
  const identity = {
    telegramUserId: '1001',
    telegramChatId: '1001',
    updateId: '5001',
  };

  await client.listOrders(identity, NEXT_CURSOR);
  await client.orderDetail(identity, DETAIL_REF);

  assert.deepEqual(JSON.parse(observed[0].init.body), {
    telegram: { userId: '1001', chatId: '1001' },
    cursor: NEXT_CURSOR,
  });
  assert.deepEqual(JSON.parse(observed[1].init.body), {
    telegram: { userId: '1001', chatId: '1001' },
    ref: DETAIL_REF,
  });
  assert.equal(observed[0].init.headers['x-telegram-update-id'], '5001');
});

test('backend timeout and malformed response become safe typed transport failures', async () => {
  const timeoutClient = new InternalBackendClient(
    {
      internalApiKey: 'internal-secret',
      backendInternalUrl: 'http://backend:3000/api',
      backendTimeoutMs: 1,
    },
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(new Error('aborted'))
        );
      })
  );
  const malformedClient = new InternalBackendClient(
    {
      internalApiKey: 'internal-secret',
      backendInternalUrl: 'http://backend:3000/api',
      backendTimeoutMs: 5000,
    },
    async () => ({ ok: true, json: async () => ({ state: 'OK' }) })
  );
  const identity = {
    telegramUserId: '1001',
    telegramChatId: '1001',
    updateId: '5002',
  };

  await assert.rejects(
    timeoutClient.listOrders(identity),
    BackendUnavailableError
  );
  await assert.rejects(
    malformedClient.listOrders(identity),
    MalformedBackendResponseError
  );
});

test('malformed backend responses are logged by correlation ID and safely rendered', async () => {
  const logs = [];
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      listOrders: async () => {
        throw new MalformedBackendResponseError();
      },
    },
    log: (record) => logs.push(record),
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(privateCommandUpdate(107, '/orders'));

  assert.equal(
    apiCalls.find((call) => call.method === 'sendMessage').payload.text,
    BOT_MESSAGES.malformedResponse
  );
  assert.ok(
    logs.some(
      (record) =>
        record.event === 'telegram_backend_request_failed' &&
        record.correlationId === 'telegram-update-107'
    )
  );
});

function privateCommandUpdate(updateId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 1001, type: 'private', first_name: 'Test' },
      from: { id: 1001, is_bot: false, first_name: 'Test' },
      text,
      entities: [{ offset: 0, length: text.length, type: 'bot_command' }],
    },
  };
}

function callbackUpdate(updateId, data) {
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
        text: 'Orders',
      },
    },
  };
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
