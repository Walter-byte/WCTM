const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createBot } = require('../dist/bot');
const { InternalBackendClient } = require('../dist/internal-backend.client');

const BOT_TOKEN = '1234567890:test-token-value-for-adapter';
const refs = Array.from(
  { length: 14 },
  (_, index) =>
    `g.${String.fromCharCode(97 + index).repeat(16)}.${String.fromCharCode(65 + index).repeat(16)}`
);

test('internal settings client sends only Telegram identity, opaque reference, and bounded value', async () => {
  const requests = [];
  const responses = [
    settingsResult(),
    settingsResult(),
    { state: 'OK', purpose: 'TIMEZONE', inputRef: refs[2] },
    settingsResult({ timezone: 'Asia/Tehran' }),
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
    updateId: '301',
  };

  await client.settings(identity);
  await client.applySettingsAction(identity, refs[0]);
  await client.startSettingsInput(identity, refs[2]);
  await client.applySettingsInput(identity, refs[2], 'Asia/Tehran');

  assert.deepEqual(
    requests.map(({ url }) => url.replace('http://backend:3000/api/', '')),
    [
      'internal/telegram/settings/summary',
      'internal/telegram/settings/action',
      'internal/telegram/settings/input/start',
      'internal/telegram/settings/input/apply',
    ]
  );
  for (const request of requests) {
    assert.deepEqual(request.body.telegram, { userId: '1001', chatId: '2001' });
    assert.ok(!('tenantId' in request.body));
    assert.ok(!('storeId' in request.body));
    assert.ok(!('membershipId' in request.body));
    assert.ok(!('telegramUserId' in request.body));
  }
  assert.equal(requests[3].body.value, 'Asia/Tehran');
});

test('/settings renders compact OWNER controls with no internal identities', async () => {
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: { settings: async () => settingsResult() },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(commandUpdate(310, '/settings'));

  const message = apiCalls.find((call) => call.method === 'sendMessage');
  assert.match(message.payload.text, /Store Settings/);
  assert.match(message.payload.text, /Language: English/);
  assert.match(message.payload.text, /Timezone: UTC/);
  assert.match(message.payload.text, /Not configured/);
  assert.match(message.payload.text, /New order/);
  assert.match(message.payload.text, /Selected managers/);
  assert.match(message.payload.text, /مدیر/);
  assert.doesNotMatch(message.payload.text, /ten_|sto_|mem_|telegram/i);
  assert.ok(callbacks(message).some((value) => value.startsWith('sg:g.')));
  assert.ok(callbacks(message).some((value) => value.startsWith('si:g.')));
  assert.ok(callbacks(message).includes('nav:home'));
});

test('MEMBER settings are backend-provided read-only and render no mutation controls', async () => {
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      settings: async () =>
        settingsResult({ editable: false, actions: undefined }),
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(commandUpdate(320, '/settings'));

  const message = apiCalls.find((call) => call.method === 'sendMessage');
  assert.match(message.payload.text, /read-only access/);
  assert.deepEqual(callbacks(message), ['nav:home']);
});

test('language/category/recipient desired-state callbacks forward the same opaque action idempotently', async () => {
  const backendCalls = [];
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      applySettingsAction: async (_identity, ref) => {
        backendCalls.push(ref);
        return settingsResult({ language: 'FA' });
      },
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(callbackUpdate(330, `sg:${refs[0]}`));
  await bot.handleUpdate(callbackUpdate(331, `sg:${refs[0]}`));

  assert.deepEqual(backendCalls, [refs[0], refs[0]]);
  const edits = apiCalls.filter((call) => call.method === 'editMessageText');
  assert.equal(edits.length, 2);
  assert.match(edits[1].payload.text, /Language: Persian/);
});

test('timezone/threshold input uses a backend-owned opaque ForceReply context', async () => {
  const backendCalls = [];
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      startSettingsInput: async (_identity, ref) => {
        backendCalls.push({ operation: 'start', ref });
        return { state: 'OK', purpose: 'TIMEZONE', inputRef: ref };
      },
      applySettingsInput: async (_identity, ref, value) => {
        backendCalls.push({ operation: 'apply', ref, value });
        return settingsResult({ timezone: value });
      },
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(callbackUpdate(340, `si:${refs[2]}`));
  await bot.handleUpdate(
    replyUpdate(
      341,
      'Asia/Tehran',
      `Reply with timezone\n\nSettings reference: ${refs[2]}`
    )
  );

  assert.deepEqual(backendCalls, [
    { operation: 'start', ref: refs[2] },
    { operation: 'apply', ref: refs[2], value: 'Asia/Tehran' },
  ]);
  const prompt = apiCalls.find(
    (call) =>
      call.method === 'sendMessage' &&
      call.payload.text.includes('Settings reference:')
  );
  assert.equal(prompt.payload.reply_markup.force_reply, true);
  assert.doesNotMatch(prompt.payload.text, /tenant|store|membership/i);
  const result = apiCalls
    .filter((call) => call.method === 'sendMessage')
    .at(-1);
  assert.match(result.payload.text, /Timezone: Asia\/Tehran/);
});

test('stale and malformed settings outcomes recover safely through Settings/Home', async () => {
  const apiCalls = [];
  const states = ['CONTEXT_CHANGED', 'INVALID_VALUE'];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      applySettingsAction: async () => ({ state: states.shift() }),
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(callbackUpdate(350, `sg:${refs[0]}`));
  await bot.handleUpdate(callbackUpdate(351, `sg:${refs[0]}`));

  const edits = apiCalls.filter((call) => call.method === 'editMessageText');
  assert.match(edits[0].payload.text, /expired or the active context changed/);
  assert.match(edits[1].payload.text, /invalid/);
  for (const edit of edits) {
    assert.deepEqual(callbacks(edit), ['nav:settings', 'nav:home']);
  }
});

function settingsResult(overrides = {}) {
  const settings = {
    language: 'EN',
    timezone: 'UTC',
    lowStockThreshold: null,
    enabledNotificationCategories: ['ORDER_CREATED'],
    recipientMode: 'SELECTED',
    selectedRecipientCount: 1,
    availableRecipientCount: 1,
    editable: true,
    recipients: [
      {
        displayName: 'مدیر فروشگاه',
        selected: true,
        availability: 'AVAILABLE',
        actionRef: refs[13],
        action: 'REMOVE',
      },
    ],
    actions: {
      languages: [
        { language: 'FA', ref: refs[0] },
        { language: 'EN', ref: refs[1] },
      ],
      timezoneInputRef: refs[2],
      thresholdInputRef: refs[3],
      thresholdClearRef: refs[4],
      categories: [
        {
          category: 'ORDER_CREATED',
          enabled: true,
          enableRef: refs[5],
          disableRef: refs[6],
        },
        {
          category: 'LOW_STOCK',
          enabled: false,
          enableRef: refs[7],
          disableRef: refs[8],
        },
      ],
      recipientModes: [
        { mode: 'ALL_ELIGIBLE', ref: refs[9] },
        { mode: 'SELECTED', ref: refs[10] },
      ],
    },
    ...overrides,
  };
  return { state: 'OK', settings };
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
        text: 'Settings',
      },
    },
  };
}

function replyUpdate(updateId, text, promptText) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 2001, type: 'private', first_name: 'Test' },
      from: { id: 1001, is_bot: false, first_name: 'Test' },
      text,
      reply_to_message: {
        message_id: updateId - 1,
        date: 1,
        chat: { id: 2001, type: 'private', first_name: 'Test' },
        from: { id: 1234567890, is_bot: true, first_name: 'Bot' },
        text: promptText,
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
