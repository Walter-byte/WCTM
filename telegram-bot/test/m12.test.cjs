const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');

const { createBot } = require('../dist/bot');
const {
  BackendUnavailableError,
  InternalBackendClient,
} = require('../dist/internal-backend.client');

const BOT_TOKEN = '1234567890:test-token-value-for-adapter';
const DETAIL_REF = `d.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const WRITE_REF = `s.${'c'.repeat(16)}.${'d'.repeat(16)}`;
const BACK_CURSOR = `p.${'e'.repeat(16)}.${'f'.repeat(16)}`;
const FRESHNESS = {
  asOf: '2026-07-24T09:00:00.000Z',
  delayed: false,
};

function detail(overrides = {}) {
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
      wcModifiedAt: '2026-07-24T09:00:00.000Z',
      remoteDeleted: false,
    },
    backCursor: BACK_CURSOR,
    transitionsRef: DETAIL_REF,
    freshness: FRESHNESS,
    ...overrides,
  };
}

test('backend-controlled detail actions render server transitions and forward a target', async () => {
  const calls = [];
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      orderDetail: async () => detail(),
      orderTransitions: async (identity, ref) => {
        calls.push({ operation: 'transitions', identity, ref });
        return {
          state: 'OK',
          ref: WRITE_REF,
          currentStatus: 'processing',
          targets: ['on-hold', 'completed'],
        };
      },
      updateOrderStatus: async (identity, ref, target) => {
        calls.push({ operation: 'status', identity, ref, target });
        return {
          ...detail({
            order: { ...detail().order, status: 'completed' },
          }),
          state: 'OK',
          transitionsRef: undefined,
        };
      },
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(callbackUpdate(201, DETAIL_REF));
  const detailEdit = apiCalls.find((call) => call.method === 'editMessageText');
  const detailCallbacks = detailEdit.payload.reply_markup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  assert.ok(detailCallbacks.includes(`t:${DETAIL_REF}`));

  await bot.handleUpdate(callbackUpdate(202, `t:${DETAIL_REF}`));
  const transitionEdit = apiCalls.filter(
    (call) => call.method === 'editMessageText'
  )[1];
  const transitionCallbacks =
    transitionEdit.payload.reply_markup.inline_keyboard
      .flat()
      .map((button) => button.callback_data);
  assert.ok(transitionCallbacks.includes(`${WRITE_REF}:completed`));
  assert.ok(transitionCallbacks.every((value) => value.length <= 64));

  await bot.handleUpdate(callbackUpdate(203, `${WRITE_REF}:completed`));
  const statusEdit = apiCalls.filter(
    (call) => call.method === 'editMessageText'
  )[2];
  assert.match(statusEdit.payload.text, /Status updated/);
  assert.match(statusEdit.payload.text, /Status: completed/);
  assert.deepEqual(
    calls.map((call) => call.operation),
    ['transitions', 'status']
  );
  assert.equal(calls[0].ref, DETAIL_REF);
  assert.equal(calls[1].ref, WRITE_REF);
  assert.equal(calls[1].target, 'completed');
});

test('read-only detail has no status action and edit failure still falls back', async () => {
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      orderDetail: async () => {
        const result = detail();
        delete result.transitionsRef;
        return result;
      },
    },
  });
  installApiStub(bot, apiCalls, { failEdits: true });

  await bot.handleUpdate(callbackUpdate(204, DETAIL_REF));

  const sent = apiCalls.find((call) => call.method === 'sendMessage');
  const callbacks = sent.payload.reply_markup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  assert.ok(!callbacks.some((value) => value.startsWith('t:')));
});

test('internal client sends transition and status contracts with bot headers', async () => {
  const observed = [];
  const request = async (url, init) => {
    observed.push({ url, init });
    return {
      ok: true,
      json: async () =>
        url.endsWith('/orders/transitions')
          ? {
              state: 'OK',
              ref: WRITE_REF,
              currentStatus: 'processing',
              targets: ['completed'],
            }
          : {
              ...detail({
                order: { ...detail().order, status: 'completed' },
              }),
              state: 'OK',
              transitionsRef: undefined,
            },
    };
  };
  const client = new InternalBackendClient(
    {
      internalApiKey: 'internal-secret',
      backendInternalUrl: 'http://backend:3000/api',
      backendTimeoutMs: 5000,
      statusWriteTimeoutMs: 50000,
    },
    request
  );
  const identity = {
    telegramUserId: '1001',
    telegramChatId: '1001',
    updateId: '6001',
  };

  await client.orderTransitions(identity, DETAIL_REF);
  await client.updateOrderStatus(identity, WRITE_REF, 'completed');

  assert.deepEqual(JSON.parse(observed[0].init.body), {
    telegram: { userId: '1001', chatId: '1001' },
    ref: DETAIL_REF,
  });
  assert.deepEqual(JSON.parse(observed[1].init.body), {
    telegram: { userId: '1001', chatId: '1001' },
    ref: WRITE_REF,
    target: 'completed',
  });
  assert.equal(observed[1].init.headers['x-telegram-update-id'], '6001');
  assert.equal(observed[1].init.headers['x-bot-api-key'], 'internal-secret');
  assert.equal(
    observed[1].init.headers['x-correlation-id'],
    'telegram-update-6001'
  );
});

test('normal requests keep the short timeout while status writes use the longer timeout', async () => {
  const observed = [];
  const request = (url, init) =>
    new Promise((resolve, reject) => {
      observed.push(url);
      const timer = setTimeout(
        () =>
          resolve({
            ok: true,
            json: async () =>
              url.endsWith('/orders/status')
                ? {
                    ...detail({
                      order: { ...detail().order, status: 'completed' },
                    }),
                    state: 'OK',
                    transitionsRef: undefined,
                  }
                : {
                    linked: true,
                    authorized: true,
                    membershipState: 'active',
                    activeTenantId: 'ten_a',
                    activeStoreId: 'sto_a',
                    tenantSelectionRequired: false,
                    storeSelectionRequired: false,
                    selectionRequired: false,
                  },
          }),
        25
      );
      init.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        },
        { once: true }
      );
    });
  const client = new InternalBackendClient(
    {
      internalApiKey: 'internal-secret',
      backendInternalUrl: 'http://backend:3000/api',
      backendTimeoutMs: 5,
      statusWriteTimeoutMs: 100,
    },
    request
  );
  const identity = {
    telegramUserId: '1001',
    telegramChatId: '1001',
    updateId: '6002',
  };

  await assert.rejects(client.status(identity), BackendUnavailableError);
  await client.updateOrderStatus(identity, WRITE_REF, 'completed');

  assert.equal(
    observed.filter((url) => url.endsWith('/internal/telegram/status')).length,
    1
  );
  assert.equal(
    observed.filter((url) => url.endsWith('/orders/status')).length,
    1
  );
});

test('status-write timeout fails safely after one backend request', async () => {
  let requestCount = 0;
  const client = new InternalBackendClient(
    {
      internalApiKey: 'internal-secret',
      backendInternalUrl: 'http://backend:3000/api',
      backendTimeoutMs: 5000,
      statusWriteTimeoutMs: 1,
    },
    (_url, init) => {
      requestCount += 1;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true }
        );
      });
    }
  );

  await assert.rejects(
    client.updateOrderStatus(
      {
        telegramUserId: '1001',
        telegramChatId: '1001',
        updateId: '6003',
      },
      WRITE_REF,
      'completed'
    ),
    BackendUnavailableError
  );
  assert.equal(requestCount, 1);
});

test('bot transport remains free of Prisma and database access', () => {
  const sources = ['bot.ts', 'internal-backend.client.ts', 'index.ts'].map(
    (file) =>
      readFileSync(resolve(__dirname, '..', 'src', file), 'utf8').toLowerCase()
  );

  for (const source of sources) {
    assert.doesNotMatch(source, /@prisma\/client|prismaservice|database_url/);
  }
});

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
        text: 'Order',
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

    if (method === 'answerCallbackQuery') {
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
