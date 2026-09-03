const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createBot } = require('../dist/bot');
const { InternalBackendClient } = require('../dist/internal-backend.client');

const BOT_TOKEN = '1234567890:test-token-value-for-adapter';
const PAGE_REF = `q.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const RESULT_REF = `u.${'c'.repeat(16)}.${'d'.repeat(16)}`;

test('M20 client sends only Telegram identity, query, and opaque references', async () => {
  const requests = [];
  const responses = [
    searchResult(),
    searchResult(),
    searchSelection(),
    reportResult(),
  ];
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
    updateId: '501',
  };

  await client.search(identity, { query: 'safe' });
  await client.search(identity, { cursor: PAGE_REF });
  await client.selectSearchResult(identity, RESULT_REF);
  await client.report(identity);

  assert.deepEqual(requests.map(({ url }) => url.split('/').at(-1)), [
    'search',
    'search',
    'select',
    'report',
  ]);
  assert.deepEqual(requests[0].body, {
    telegram: { userId: '1001', chatId: '2001' },
    query: 'safe',
  });
  assert.deepEqual(requests[1].body, {
    telegram: { userId: '1001', chatId: '2001' },
    cursor: PAGE_REF,
  });
  assert.deepEqual(requests[2].body, {
    telegram: { userId: '1001', chatId: '2001' },
    ref: RESULT_REF,
  });
  assert.doesNotMatch(JSON.stringify(requests), /tenantId|storeId|wcOrderId/);
});

test('/search renders mixed projection results and partial inventory state safely', async () => {
  const calls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      search: async (_identity, input) => {
        assert.deepEqual(input, { query: 'sam' });
        return searchResult({ inventoryState: 'BOOTSTRAPPING' });
      },
    },
  });
  installApiStub(bot, calls);

  await bot.handleUpdate(commandUpdate(510, '/search sam'));

  const message = calls.find((call) => call.method === 'sendMessage');
  assert.match(message.payload.text, /Order #1001.*Sam Example/);
  assert.match(message.payload.text, /HEALTHY.*Sample Product.*SKU SKU-1/);
  assert.match(message.payload.text, /include Orders only.*partial/);
  assert.ok(callbacks(message).includes(RESULT_REF));
  assert.doesNotMatch(message.payload.text, /email|phone|address|payment/i);
});

test('/search 312 preserves the numeric SKU and opens its signed inventory result', async () => {
  const calls = [];
  const backendCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      search: async (_identity, input) => {
        backendCalls.push({ operation: 'search', input });
        return {
          ...searchResult(),
          results: [
            {
              ref: RESULT_REF,
              kind: 'INVENTORY',
              status: 'outofstock',
              displayName: 'Oakley OO9501 Velo Kato',
              sku: '312',
              quantity: '0',
              classification: 'OUT_OF_STOCK',
            },
          ],
        };
      },
      selectSearchResult: async (_identity, ref) => {
        backendCalls.push({ operation: 'select', ref });
        return {
          ...searchSelection(),
          detail: {
            ...searchSelection().detail,
            item: {
              ...searchSelection().detail.item,
              displayName: 'Oakley OO9501 Velo Kato',
              sku: '312',
              quantity: '0',
              stockStatus: 'outofstock',
              classification: 'OUT_OF_STOCK',
            },
          },
        };
      },
    },
  });
  installApiStub(bot, calls);

  await bot.handleUpdate(commandUpdate(530, '/search 312'));
  const searchMessage = calls.find((call) => call.method === 'sendMessage');
  assert.match(searchMessage.payload.text, /Oakley OO9501 Velo Kato.*SKU 312/);
  assert.ok(callbacks(searchMessage).includes(RESULT_REF));

  await bot.handleUpdate(callbackUpdate(531, RESULT_REF));
  const detailMessage = calls.find(
    (call) =>
      call.method === 'editMessageText' &&
      /Oakley OO9501 Velo Kato/.test(call.payload.text)
  );
  assert.match(detailMessage.payload.text, /SKU: 312/);
  assert.deepEqual(backendCalls, [
    { operation: 'search', input: { query: '312' } },
    { operation: 'select', ref: RESULT_REF },
  ]);
});

test('/report renders separated currencies and unavailable inventory without scheduling', async () => {
  const calls = [];
  let reportCalls = 0;
  const bot = createBot(BOT_TOKEN, {
    backend: {
      report: async () => {
        reportCalls += 1;
        return reportResult();
      },
    },
  });
  installApiStub(bot, calls);

  await bot.handleUpdate(commandUpdate(520, '/report'));

  assert.equal(reportCalls, 1);
  const message = calls.find((call) => call.method === 'sendMessage');
  assert.match(message.payload.text, /Gross sales \(EUR\): 5.00/);
  assert.match(message.payload.text, /Gross sales \(USD\): 30.30/);
  assert.match(message.payload.text, /Inventory counts unavailable/);
  assert.match(message.payload.text, /not accounting or net revenue/);
});

function searchResult(overrides = {}) {
  return {
    state: 'OK',
    results: [
      {
        ref: RESULT_REF,
        kind: 'ORDER',
        orderNumber: '1001',
        status: 'processing',
        customerDisplayName: 'Sam Example',
        currency: 'USD',
        total: '10.00',
      },
      {
        ref: `u.${'e'.repeat(16)}.${'f'.repeat(16)}`,
        kind: 'INVENTORY',
        status: 'instock',
        displayName: 'Sample Product',
        sku: 'SKU-1',
        quantity: '10',
        classification: 'HEALTHY',
      },
    ],
    nextCursor: null,
    previousCursor: null,
    inventoryState: 'READY',
    ...overrides,
  };
}

function reportResult() {
  return {
    state: 'OK',
    localDate: '2026-09-03',
    timezone: 'Asia/Tehran',
    ordersToday: 3,
    statuses: [{ status: 'completed', count: 3 }],
    sales: [
      { currency: 'EUR', gross: '5.00', averageOrderValue: '5.00', orderCount: 1 },
      { currency: 'USD', gross: '30.30', averageOrderValue: '15.15', orderCount: 2 },
    ],
    omittedRevenueOrders: 0,
    inventory: { state: 'UNAVAILABLE', syncState: 'BOOTSTRAPPING' },
    projection: { asOf: null, delayed: true },
  };
}

function searchSelection() {
  return {
    state: 'INVENTORY',
    backCursor: PAGE_REF,
    detail: {
      state: 'OK',
      item: {
        displayName: 'Sample Product',
        sku: 'SKU-1',
        quantity: '10',
        stockStatus: 'instock',
        classification: 'HEALTHY',
        kind: 'PRODUCT',
        variationContext: [],
        threshold: 5,
        lastSyncedAt: '2026-09-03T10:00:00.000Z',
      },
    },
  };
}

function commandUpdate(updateId, text) {
  const command = text.split(' ')[0];
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 2001, type: 'private', first_name: 'Test' },
      from: { id: 1001, is_bot: false, first_name: 'Test' },
      text,
      entities: [{ offset: 0, length: command.length, type: 'bot_command' }],
    },
  };
}

function callbackUpdate(updateId, data) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: 1001, is_bot: false, first_name: 'Test' },
      message: {
        message_id: 999,
        date: 1,
        chat: { id: 2001, type: 'private', first_name: 'Test' },
        text: 'Search Results',
      },
      chat_instance: 'test-chat-instance',
      data,
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
    return {
      ok: true,
      result:
        method === 'answerCallbackQuery'
          ? true
          : {
              message_id: 999,
              date: 1,
              chat: { id: Number(payload.chat_id ?? 2001), type: 'private' },
              text: payload.text ?? '',
            },
    };
  });
}
