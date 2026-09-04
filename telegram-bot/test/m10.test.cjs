const assert = require('node:assert/strict');
const { test } = require('node:test');

const { BOT_MESSAGES, createBot, renderStatus } = require('../dist/bot');
const { loadBotConfiguration } = require('../dist/config');
const { InternalBackendClient } = require('../dist/internal-backend.client');
const { UpdateDeduplicator } = require('../dist/update-deduplicator');

const BOT_TOKEN = '1234567890:test-token-value-for-adapter';

test('bot configuration validates all internal transport values without exposing them', () => {
  const configuration = loadBotConfiguration({
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    BOT_INTERNAL_API_KEY: 'internal-secret',
    BACKEND_INTERNAL_URL: 'http://backend:3000/api/',
  });

  assert.equal(configuration.backendInternalUrl, 'http://backend:3000/api');
  assert.equal(configuration.backendTimeoutMs, 5000);
  assert.equal(configuration.statusWriteTimeoutMs, 50000);
  assert.throws(
    () =>
      loadBotConfiguration({
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      }),
    /BOT_INTERNAL_API_KEY, BACKEND_INTERNAL_URL/
  );
  assert.throws(
    () =>
      loadBotConfiguration({
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        BOT_INTERNAL_API_KEY: 'internal-secret',
        BACKEND_INTERNAL_URL: 'http://backend:3000/api',
        BOT_STATUS_WRITE_TIMEOUT_MS: '0',
      }),
    /BOT_STATUS_WRITE_TIMEOUT_MS/
  );
});

test('bot production configuration rejects committed placeholders without exposing values', () => {
  const placeholder = 'development-only-bot-internal-api-key';

  assert.throws(
    () =>
      loadBotConfiguration({
        NODE_ENV: 'production',
        TELEGRAM_BOT_TOKEN: '0000000000:development-placeholder-token',
        BOT_INTERNAL_API_KEY: placeholder,
        BACKEND_INTERNAL_URL: 'http://backend:3000/api',
      }),
    (error) => {
      assert.match(error.message, /TELEGRAM_BOT_TOKEN/);
      assert.match(error.message, /BOT_INTERNAL_API_KEY/);
      assert.doesNotMatch(error.message, new RegExp(placeholder));
      return true;
    }
  );
});

test('internal client propagates bot key, correlation ID, and Telegram update ID', async () => {
  let observed;
  const request = async (url, init) => {
    observed = { url, init };
    return {
      ok: true,
      json: async () => ({
        linked: false,
        authorized: false,
        membershipState: 'none',
        activeTenantId: null,
        activeStoreId: null,
        tenantSelectionRequired: false,
        storeSelectionRequired: false,
        selectionRequired: false,
      }),
    };
  };
  const client = new InternalBackendClient(
    {
      internalApiKey: 'internal-secret',
      backendInternalUrl: 'http://backend:3000/api',
    },
    request
  );

  await client.status({
    telegramUserId: '1001',
    telegramChatId: '1001',
    updateId: '5001',
  });

  assert.equal(
    observed.url,
    'http://backend:3000/api/internal/telegram/status'
  );
  assert.equal(observed.init.headers['x-bot-api-key'], 'internal-secret');
  assert.equal(observed.init.headers['x-telegram-update-id'], '5001');
  assert.equal(
    observed.init.headers['x-correlation-id'],
    'telegram-update-5001'
  );
  assert.deepEqual(JSON.parse(observed.init.body), {
    telegramUserId: '1001',
    telegramChatId: '1001',
    updateId: '5001',
  });
});

test('update deduplication is bounded and rejects repeated update IDs', () => {
  const deduplicator = new UpdateDeduplicator(2);

  assert.equal(deduplicator.accept(1), true);
  assert.equal(deduplicator.accept(1), false);
  assert.equal(deduplicator.accept(2), true);
  assert.equal(deduplicator.accept(3), true);
  assert.equal(deduplicator.accept(1), true);
});

test('status rendering covers linked, selection-required, and unauthorized states', () => {
  assert.match(
    renderStatus({
      linked: false,
      authorized: false,
      selectionRequired: false,
      activeTenantId: null,
      activeStoreId: null,
    }),
    /not linked/
  );
  assert.match(
    renderStatus({
      linked: true,
      authorized: true,
      selectionRequired: true,
      activeTenantId: null,
      activeStoreId: null,
    }),
    /selection is required/
  );
  assert.match(
    renderStatus({
      linked: true,
      authorized: true,
      selectionRequired: false,
      activeTenantId: 'ten_a',
      activeStoreId: 'sto_a',
    }),
    /linked and authorized/
  );
});

test('group, supergroup, and channel updates receive one rejection and make no backend call', async () => {
  for (const [index, chatType] of [
    'group',
    'supergroup',
    'channel',
  ].entries()) {
    const backendCalls = [];
    const apiCalls = [];
    const bot = createBot(BOT_TOKEN, {
      backend: {
        status: async (...args) => {
          backendCalls.push(args);
          throw new Error('must not be called');
        },
      },
    });
    installApiStub(bot, apiCalls);
    const chat =
      chatType === 'channel'
        ? { id: -100 - index, type: chatType, title: 'Channel' }
        : { id: -100 - index, type: chatType, title: 'Group' };

    await bot.handleUpdate({
      update_id: 100 + index,
      message: {
        message_id: 1,
        date: 1,
        chat,
        from: { id: 1001, is_bot: false, first_name: 'Test' },
        text: '/status',
        entities: [{ offset: 0, length: 7, type: 'bot_command' }],
      },
    });

    assert.equal(backendCalls.length, 0);
    assert.equal(
      apiCalls.filter((call) => call.method === 'sendMessage').length,
      1
    );
    assert.equal(
      apiCalls.find((call) => call.method === 'sendMessage').payload.text,
      BOT_MESSAGES.privateOnly
    );
  }
});

test('private status is deduplicated and confirmed unlink calls backend once', async () => {
  const statusCalls = [];
  const unlinkCalls = [];
  const apiCalls = [];
  const backend = {
    status: async (identity) => {
      statusCalls.push(identity);
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
    },
    unlink: async (identity, confirmed) => {
      unlinkCalls.push({ identity, confirmed });
      return { status: 'unlinked' };
    },
  };
  const bot = createBot(BOT_TOKEN, { backend });
  installApiStub(bot, apiCalls);
  const statusUpdate = privateCommandUpdate(200, '/status');

  await bot.handleUpdate(statusUpdate);
  await bot.handleUpdate(statusUpdate);

  assert.equal(statusCalls.length, 1);
  assert.deepEqual(statusCalls[0], {
    telegramUserId: '1001',
    telegramChatId: '1001',
    updateId: '200',
  });

  await bot.handleUpdate(privateCommandUpdate(201, '/unlink'));
  assert.equal(unlinkCalls.length, 0);

  await bot.handleUpdate({
    update_id: 202,
    callback_query: {
      id: 'callback-1',
      chat_instance: 'instance-1',
      from: { id: 1001, is_bot: false, first_name: 'Test' },
      data: 'unlink:confirm',
      message: {
        message_id: 2,
        date: 1,
        chat: { id: 1001, type: 'private', first_name: 'Test' },
        text: 'Confirm',
      },
    },
  });

  assert.equal(unlinkCalls.length, 1);
  assert.equal(unlinkCalls[0].confirmed, true);
  assert.equal(unlinkCalls[0].identity.updateId, '202');
});

test('start redeems a token once and backend failures produce a transient reply', async () => {
  const redeemCalls = [];
  const apiCalls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      redeem: async (identity, token) => {
        redeemCalls.push({ identity, token });
        return { status: 'invalid_or_expired' };
      },
      status: async () => {
        throw new Error('backend unavailable');
      },
    },
  });
  installApiStub(bot, apiCalls);

  await bot.handleUpdate(
    privateCommandUpdate(300, `/start tgl_${'a'.repeat(43)}`, 6)
  );
  await bot.handleUpdate(privateCommandUpdate(301, '/status'));

  assert.equal(redeemCalls.length, 1);
  assert.equal(redeemCalls[0].token, `tgl_${'a'.repeat(43)}`);
  const replies = apiCalls
    .filter((call) => call.method === 'sendMessage')
    .map((call) => call.payload.text);
  assert.ok(replies.includes(BOT_MESSAGES.invalidToken));
  assert.ok(replies.includes(BOT_MESSAGES.transientFailure));
});

function privateCommandUpdate(updateId, text, commandLength = text.length) {
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
