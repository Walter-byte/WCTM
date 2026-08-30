const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createBot } = require('../dist/bot');
const { InternalBackendClient } = require('../dist/internal-backend.client');

const BOT_TOKEN = '1234567890:test-token-value-for-adapter';
const DETAIL_REF = `d.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const BACK_CURSOR = `p.${'c'.repeat(16)}.${'d'.repeat(16)}`;
const INPUT_REF = `i.${'e'.repeat(16)}.${'f'.repeat(16)}`;
const CONFIRM_REF = `c.${'g'.repeat(16)}.${'h'.repeat(16)}`;
const FRESHNESS = {
  asOf: '2026-08-30T09:00:00.000Z',
  delayed: false,
};

test('internal client sends only Telegram identity, exact number, and opaque references for M17', async () => {
  const requests = [];
  const responses = [
    orderDetail(),
    orderDetail(),
    { state: 'OK', ref: DETAIL_REF, visibilities: ['INTERNAL', 'CUSTOMER'] },
    {
      state: 'OK',
      inputRef: INPUT_REF,
      detailRef: DETAIL_REF,
      visibility: 'INTERNAL',
      maxLength: 1000,
    },
    {
      state: 'OK',
      confirmRef: CONFIRM_REF,
      detailRef: DETAIL_REF,
      visibility: 'INTERNAL',
      preview: 'Plain note',
    },
    { state: 'CANCELLED', detailRef: DETAIL_REF },
    {
      state: 'OK',
      detailRef: DETAIL_REF,
      visibility: 'INTERNAL',
      orderNumber: '1001',
    },
  ];
  const client = new InternalBackendClient(
    {
      internalApiKey: 'bot-key',
      backendInternalUrl: 'http://backend:3000/api',
      backendTimeoutMs: 5000,
      statusWriteTimeoutMs: 50000,
    },
    async (url, init) => {
      requests.push({
        url,
        body: JSON.parse(init.body),
        headers: init.headers,
      });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
  );
  const identity = {
    telegramUserId: '1001',
    telegramChatId: '1001',
    updateId: '199',
  };

  await client.lookupOrder(identity, '1001');
  await client.refreshOrder(identity, DETAIL_REF);
  await client.orderNoteOptions(identity, DETAIL_REF);
  await client.startOrderNote(identity, DETAIL_REF, 'INTERNAL');
  await client.prepareOrderNote(identity, INPUT_REF, 'Plain note');
  await client.cancelOrderNote(identity, INPUT_REF);
  await client.confirmOrderNote(identity, CONFIRM_REF);

  assert.deepEqual(
    requests.map(({ url }) => url.replace('http://backend:3000/api/', '')),
    [
      'internal/telegram/orders/lookup',
      'internal/telegram/orders/refresh',
      'internal/telegram/orders/notes/options',
      'internal/telegram/orders/notes/start',
      'internal/telegram/orders/notes/prepare',
      'internal/telegram/orders/notes/cancel',
      'internal/telegram/orders/notes/confirm',
    ]
  );
  for (const request of requests) {
    assert.deepEqual(request.body.telegram, { userId: '1001', chatId: '1001' });
    assert.ok(!('tenantId' in request.body));
    assert.ok(!('storeId' in request.body));
    assert.ok(!('orderId' in request.body));
  }
  assert.equal(requests[0].body.orderNumber, '1001');
  assert.equal(requests[4].body.note, 'Plain note');
});

test('/order performs exact lookup and renders minimized context plus secure actions', async () => {
  const backendCalls = [];
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      lookupOrder: async (_identity, orderNumber) => {
        backendCalls.push({ operation: 'lookup', orderNumber });
        return orderDetail();
      },
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(privateCommandUpdate(200, '/order 1001'));

  assert.deepEqual(backendCalls, [
    { operation: 'lookup', orderNumber: '1001' },
  ]);
  const message = apiCalls.find((call) => call.method === 'sendMessage');
  assert.match(message.payload.text, /Order #1001/);
  assert.match(message.payload.text, /Payment: Cash on delivery • Unpaid/);
  assert.match(message.payload.text, /Shipping: Flat rate/);
  assert.match(message.payload.text, /Ship to: Fulfillment Street 1/);
  assert.doesNotMatch(message.payload.text, /transaction|phone|email/i);
  assert.deepEqual(callbacks(message), [
    BACK_CURSOR,
    `t:${DETAIL_REF}`,
    `r:${DETAIL_REF}`,
    `n:${DETAIL_REF}`,
    'nav:home',
  ]);
});

test('/order malformed and missing outcomes fail safely without revealing another Store', async () => {
  const apiCalls = [];
  const states = ['MALFORMED_ORDER_NUMBER', 'NOT_FOUND'];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      lookupOrder: async () => ({
        state: states.shift(),
        freshness: FRESHNESS,
      }),
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(privateCommandUpdate(210, '/order'));
  await bot.handleUpdate(privateCommandUpdate(211, '/order 9999'));

  const messages = apiCalls.filter((call) => call.method === 'sendMessage');
  assert.match(messages[0].payload.text, /Use \/order <number>/);
  assert.match(messages[1].payload.text, /no longer available/i);
  assert.doesNotMatch(messages[1].payload.text, /tenant|store/i);
});

test('Refresh forwards the M11 detail reference and preserves Back/Home continuity', async () => {
  const backendCalls = [];
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      refreshOrder: async (_identity, ref) => {
        backendCalls.push({ operation: 'refresh', ref });
        return orderDetail();
      },
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(callbackUpdate(220, `r:${DETAIL_REF}`));

  assert.deepEqual(backendCalls, [{ operation: 'refresh', ref: DETAIL_REF }]);
  const edit = apiCalls.find((call) => call.method === 'editMessageText');
  assert.match(edit.payload.text, /refreshed from WooCommerce/i);
  assert.ok(callbacks(edit).includes(BACK_CURSOR));
  assert.ok(callbacks(edit).includes('nav:home'));
});

test('Add Note uses backend-owned visibility, reply correlation, confirmation, and one mutation call', async () => {
  const backendCalls = [];
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      orderNoteOptions: async (_identity, ref) => {
        backendCalls.push({ operation: 'options', ref });
        return {
          state: 'OK',
          ref,
          visibilities: ['INTERNAL', 'CUSTOMER'],
        };
      },
      startOrderNote: async (_identity, ref, visibility) => {
        backendCalls.push({ operation: 'start', ref, visibility });
        return {
          state: 'OK',
          inputRef: INPUT_REF,
          detailRef: ref,
          visibility,
          maxLength: 1000,
        };
      },
      prepareOrderNote: async (_identity, ref, note) => {
        backendCalls.push({ operation: 'prepare', ref, note });
        return {
          state: 'OK',
          confirmRef: CONFIRM_REF,
          detailRef: DETAIL_REF,
          visibility: 'CUSTOMER',
          preview: note,
        };
      },
      confirmOrderNote: async (_identity, ref) => {
        backendCalls.push({ operation: 'confirm', ref });
        return {
          state: 'OK',
          detailRef: DETAIL_REF,
          visibility: 'CUSTOMER',
          orderNumber: '1001',
        };
      },
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(callbackUpdate(230, `n:${DETAIL_REF}`));
  await bot.handleUpdate(callbackUpdate(231, `v:${DETAIL_REF}:CUSTOMER`));
  await bot.handleUpdate(
    noteReplyUpdate(
      232,
      'Please expect delivery tomorrow.',
      `Reply with note\n\nNote reference: ${INPUT_REF}`
    )
  );
  await bot.handleUpdate(callbackUpdate(233, `nc:${CONFIRM_REF}`));

  assert.deepEqual(backendCalls, [
    { operation: 'options', ref: DETAIL_REF },
    { operation: 'start', ref: DETAIL_REF, visibility: 'CUSTOMER' },
    {
      operation: 'prepare',
      ref: INPUT_REF,
      note: 'Please expect delivery tomorrow.',
    },
    { operation: 'confirm', ref: CONFIRM_REF },
  ]);
  const prompt = apiCalls
    .filter((call) => call.method === 'sendMessage')
    .find((call) => call.payload.text.includes('Note reference:'));
  assert.equal(prompt.payload.reply_markup.force_reply, true);
  const confirmation = apiCalls
    .filter((call) => call.method === 'sendMessage')
    .find((call) => call.payload.text.includes('Confirm Order Note'));
  assert.match(confirmation.payload.text, /Customer-visible/);
  assert.deepEqual(callbacks(confirmation), [
    `nc:${CONFIRM_REF}`,
    `x:${CONFIRM_REF}`,
    DETAIL_REF,
    'nav:home',
  ]);
  const result = apiCalls
    .filter((call) => call.method === 'editMessageText')
    .at(-1);
  assert.match(result.payload.text, /created once in WooCommerce/);
  assert.deepEqual(callbacks(result), [DETAIL_REF, 'nav:home']);
});

test('MEMBER detail has no Add Note action and cancellation makes no mutation call', async () => {
  const apiCalls = [];
  let confirmCalls = 0;
  const bot = createBot(BOT_TOKEN, {
    backend: {
      orderDetail: async () => ({
        ...orderDetail(),
        addNoteRef: undefined,
      }),
      cancelOrderNote: async () => ({
        state: 'CANCELLED',
        detailRef: DETAIL_REF,
      }),
      confirmOrderNote: async () => {
        confirmCalls += 1;
        return { state: 'FAILED' };
      },
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(callbackUpdate(240, DETAIL_REF));
  await bot.handleUpdate(callbackUpdate(241, `x:${INPUT_REF}`));

  const detail = apiCalls.find(
    (call) =>
      call.method === 'editMessageText' &&
      call.payload.text.includes('Order #1001')
  );
  assert.ok(!callbacks(detail).some((value) => value.startsWith('n:')));
  const cancelled = apiCalls
    .filter((call) => call.method === 'editMessageText')
    .at(-1);
  assert.match(cancelled.payload.text, /Nothing was sent to WooCommerce/);
  assert.equal(confirmCalls, 0);
});

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
      payment: { method: 'Cash on delivery', paid: false },
      shipping: {
        methods: ['Flat rate'],
        addressLines: ['Fulfillment Street 1', 'Tehran, 12345', 'IR'],
      },
      wcCreatedAt: '2026-08-30T08:00:00.000Z',
      wcModifiedAt: '2026-08-30T09:00:00.000Z',
      remoteDeleted: false,
    },
    backCursor: BACK_CURSOR,
    transitionsRef: DETAIL_REF,
    refreshRef: DETAIL_REF,
    addNoteRef: DETAIL_REF,
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

function noteReplyUpdate(updateId, text, promptText) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 1001, type: 'private', first_name: 'Test' },
      from: { id: 1001, is_bot: false, first_name: 'Test' },
      text,
      reply_to_message: {
        message_id: updateId - 1,
        date: 1,
        chat: { id: 1001, type: 'private', first_name: 'Test' },
        from: { id: 1234567890, is_bot: true, first_name: 'Bot' },
        text: promptText,
      },
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
        text: 'Management',
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
        chat: { id: Number(payload.chat_id ?? 1001), type: 'private' },
        text: payload.text ?? '',
      },
    };
  });
}
