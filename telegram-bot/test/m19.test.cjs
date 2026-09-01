const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createBot } = require('../dist/bot');
const { InternalBackendClient } = require('../dist/internal-backend.client');

const BOT_TOKEN = '1234567890:test-token-value-for-adapter';
const LIST_REF = `k.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const NEXT_REF = `k.${'c'.repeat(16)}.${'d'.repeat(16)}`;
const DETAIL_REF = `v.${'e'.repeat(16)}.${'f'.repeat(16)}`;
const SECOND_DETAIL_REF = `v.${'g'.repeat(16)}.${'h'.repeat(16)}`;

test('internal stock client sends only Telegram identity and opaque references', async () => {
  const requests = [];
  const responses = [stockList(), stockDetail()];
  const client = new InternalBackendClient(
    {
      internalApiKey: 'bot-key',
      backendInternalUrl: 'http://backend:3000/api',
      backendTimeoutMs: 5000,
      statusWriteTimeoutMs: 50000,
    },
    async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    }
  );
  const identity = {
    telegramUserId: '1001',
    telegramChatId: '2001',
    updateId: '401',
  };

  await client.listStock(identity, LIST_REF);
  await client.stockDetail(identity, DETAIL_REF);

  assert.deepEqual(
    requests.map(({ url }) => url.replace('http://backend:3000/api/', '')),
    ['internal/telegram/stock/list', 'internal/telegram/stock/detail']
  );
  assert.deepEqual(requests[0].body, {
    telegram: { userId: '1001', chatId: '2001' },
    cursor: LIST_REF,
  });
  assert.deepEqual(requests[1].body, {
    telegram: { userId: '1001', chatId: '2001' },
    ref: DETAIL_REF,
  });
  assert.ok(!JSON.stringify(requests).includes('tenantId'));
  assert.ok(!JSON.stringify(requests).includes('storeId'));
  assert.ok(!JSON.stringify(requests).includes('wcItemId'));
});

test('/stock renders current low/out rows and opaque pagination/detail callbacks', async () => {
  const calls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: { listStock: async () => stockList() },
  });
  installApiStub(bot, calls);

  await bot.handleUpdate(commandUpdate(410, '/stock'));

  const message = calls.find((call) => call.method === 'sendMessage');
  assert.match(message.payload.text, /Inventory/);
  assert.match(message.payload.text, /WCTM low-stock threshold: 5/);
  assert.match(message.payload.text, /OUT OF STOCK.*Product One/);
  assert.match(message.payload.text, /LOW STOCK.*Blue Shirt/);
  assert.deepEqual(callbacks(message), [
    DETAIL_REF,
    SECOND_DETAIL_REF,
    NEXT_REF,
    'nav:home',
  ]);
  assert.doesNotMatch(message.payload.text, /ten_|sto_|wcItemId|description|price/i);
});

test('stock pagination and detail callbacks stay stateless and read-only', async () => {
  const backendCalls = [];
  const calls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      listStock: async (_identity, cursor) => {
        backendCalls.push({ operation: 'list', cursor });
        return stockList();
      },
      stockDetail: async (_identity, ref) => {
        backendCalls.push({ operation: 'detail', ref });
        return stockDetail();
      },
    },
  });
  installApiStub(bot, calls);

  await bot.handleUpdate(callbackUpdate(420, NEXT_REF));
  await bot.handleUpdate(callbackUpdate(421, DETAIL_REF));

  assert.deepEqual(backendCalls, [
    { operation: 'list', cursor: NEXT_REF },
    { operation: 'detail', ref: DETAIL_REF },
  ]);
  const detail = calls
    .filter((call) => call.method === 'editMessageText')
    .find((call) => call.payload.text.includes('Variation:'));
  assert.match(detail.payload.text, /Blue Shirt/);
  assert.match(detail.payload.text, /Variation: Color: Blue, Size: M/);
  assert.match(detail.payload.text, /Quantity: 2/);
  assert.match(detail.payload.text, /WooCommerce status: instock/);
  assert.deepEqual(callbacks(detail), [LIST_REF, 'nav:home']);
  assert.ok(!callbacks(detail).some((value) => /set|adjust|write/i.test(value)));
});

test('initializing and failed stock projections render actionable safe states', async () => {
  const states = ['SYNCING', 'SYNC_FAILED'];
  const calls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      listStock: async () => ({
        state: states.shift(),
        items: [],
        nextCursor: null,
        previousCursor: null,
        threshold: null,
      }),
    },
  });
  installApiStub(bot, calls);

  await bot.handleUpdate(commandUpdate(430, '/stock'));
  await bot.handleUpdate(commandUpdate(431, '/stock'));

  const messages = calls.filter((call) => call.method === 'sendMessage');
  assert.match(messages[0].payload.text, /synchronizing.*WooCommerce/i);
  assert.match(messages[1].payload.text, /Recovery has been queued/i);
  for (const message of messages) {
    assert.deepEqual(callbacks(message), ['nav:stock', 'nav:home']);
  }
});

function stockList(overrides = {}) {
  return {
    state: 'OK',
    items: [
      {
        ref: DETAIL_REF,
        displayName: 'Product One',
        sku: 'SKU-1',
        quantity: '0',
        stockStatus: 'outofstock',
        classification: 'OUT_OF_STOCK',
        kind: 'PRODUCT',
      },
      {
        ref: SECOND_DETAIL_REF,
        displayName: 'Blue Shirt',
        sku: null,
        quantity: '2',
        stockStatus: 'instock',
        classification: 'LOW_STOCK',
        kind: 'VARIATION',
      },
    ],
    nextCursor: NEXT_REF,
    previousCursor: null,
    threshold: 5,
    ...overrides,
  };
}

function stockDetail() {
  return {
    state: 'OK',
    item: {
      displayName: 'Blue Shirt',
      sku: null,
      quantity: '2',
      stockStatus: 'instock',
      classification: 'LOW_STOCK',
      kind: 'VARIATION',
      variationContext: [
        { name: 'Color', option: 'Blue' },
        { name: 'Size', option: 'M' },
      ],
      threshold: 5,
      lastSyncedAt: '2026-09-01T08:00:00.000Z',
    },
    backCursor: LIST_REF,
  };
}

function commandUpdate(updateId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 2001, type: 'private', first_name: 'Test' },
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
        chat: { id: 2001, type: 'private', first_name: 'Test' },
        text: 'Inventory',
      },
    },
  };
}

function callbacks(call) {
  return call.payload.reply_markup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
}

function installApiStub(bot, calls) {
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
    if (method === 'answerCallbackQuery') {
      return { ok: true, result: true };
    }
    return {
      ok: true,
      result: {
        message_id: 999,
        date: 1,
        chat: { id: Number(payload.chat_id ?? 2001), type: 'private' },
        text: payload.text ?? '',
      },
    };
  });
}
