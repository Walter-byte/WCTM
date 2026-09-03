const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createBot,
  renderDailyReport,
  renderOrderDetail,
  renderOrderList,
  renderOrderNoteOptions,
  renderOrderTransitions,
  renderSearch,
  renderSettings,
  renderStatus,
  renderStockDetail,
  renderStockList,
} = require('../dist/bot');
const {
  renderPreparedNotification,
} = require('../dist/internal-delivery.server');
const {
  catalogs,
  commandMenu,
  formatDateTime,
  formatMoney,
  inventoryLabel,
  isolateLtr,
  resolveLanguage,
  statusLabel,
  translate,
  translateFromCatalogs,
} = require('../dist/localization');

const BOT_TOKEN = '1234567890:test-token-value-for-adapter';
const ORDER_REF = `d.${'a'.repeat(16)}.${'b'.repeat(16)}`;
const STOCK_REF = `v.${'c'.repeat(16)}.${'d'.repeat(16)}`;
const SETTINGS_REF = `g.${'e'.repeat(16)}.${'f'.repeat(16)}`;

test('fa and en catalogs have exact key parity', () => {
  assert.deepEqual(
    Object.keys(catalogs.fa).sort(),
    Object.keys(catalogs.en).sort()
  );
});

test('interpolation is bounded, strips controls, and missing keys fail safely', () => {
  const diagnostics = [];
  const source = {
    en: { greeting: 'Hello {value}' },
    fa: {},
  };
  const value = `A\u0000\u202e${'x'.repeat(600)}`;

  const fallback = translateFromCatalogs(
    'fa',
    'greeting',
    { value },
    source,
    (key) => diagnostics.push(key)
  );
  assert.match(fallback, /^Hello Ax+$/);
  assert.ok(fallback.length <= 'Hello '.length + 512);
  assert.doesNotMatch(fallback, /[\u0000\u202e]/);
  assert.deepEqual(diagnostics, ['missing-fa:greeting']);

  assert.equal(
    translateFromCatalogs(
      'fa',
      'customer email@example.test',
      {},
      source,
      (key) => diagnostics.push(key)
    ),
    catalogs.en['fallback.missing']
  );
  assert.equal(diagnostics.at(-1), 'missing-all:invalid-key');
});

test('default missing-key diagnostics expose only safe codes and catalog-like keys', () => {
  const records = [];
  const original = console.warn;
  console.warn = (value) => records.push(value);

  try {
    assert.equal(
      translate('fa', 'customer email@example.test'),
      catalogs.en['fallback.missing']
    );
  } finally {
    console.warn = original;
  }

  assert.equal(records.length, 2);
  assert.deepEqual(JSON.parse(records[0]), {
    event: 'telegram_localization_fallback',
    code: 'missing-fa',
    key: 'invalid-key',
  });
  assert.doesNotMatch(records.join('\n'), /customer|email|example/i);
});

test('language, status, inventory, money, bidi, and command presentation are semantic', () => {
  assert.equal(resolveLanguage('fa'), 'fa');
  assert.equal(resolveLanguage('en'), 'en');
  assert.equal(resolveLanguage('de'), 'en');
  assert.equal(isolateLtr('SKU-12'), '\u2068SKU-12\u2069');
  assert.equal(isolateLtr('SKU\u2069-12'), '\u2068SKU-12\u2069');
  assert.equal(statusLabel('completed', 'en'), 'Completed');
  assert.equal(statusLabel('completed', 'fa'), 'تکمیل‌شده');
  assert.equal(
    statusLabel('custom-ready', 'fa'),
    'وضعیت سفارشی (\u2068custom-ready\u2069)'
  );
  assert.equal(inventoryLabel('OUT_OF_STOCK', 'en'), 'Out of stock');
  assert.equal(inventoryLabel('OUT_OF_STOCK', 'fa'), 'ناموجود');
  assert.match(formatMoney('12.50', 'USD', 'en'), /USD\s?12\.50/);
  assert.equal(
    formatMoney('12.5', 'X-CUSTOM', 'en'),
    '12.5 \u2068X-CUSTOM\u2069'
  );
  assert.equal(
    commandMenu('fa').find(({ command }) => command === 'orders').description,
    'سفارش‌های اخیر'
  );
});

test('date formatting uses the Tenant timezone with Persian and Gregorian calendars', () => {
  const timestamp = '2026-03-21T20:30:00.000Z';
  const fa = formatDateTime(timestamp, 'fa', 'Asia/Tehran');
  const en = formatDateTime(timestamp, 'en', 'Asia/Tehran');

  assert.equal(
    fa,
    new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
      timeZone: 'Asia/Tehran',
      calendar: 'persian',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).format(new Date(timestamp))
  );
  assert.equal(
    en,
    new Intl.DateTimeFormat('en-GB-u-ca-gregory', {
      timeZone: 'Asia/Tehran',
      calendar: 'gregory',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).format(new Date(timestamp))
  );
  assert.match(fa, /۱۴۰۵/);
  assert.match(en, /2026/);
});

test('Tenant presentation controls Home and ignores Telegram client language', async () => {
  for (const [tenantLanguage, clientLanguage, expected] of [
    ['fa', 'en', 'مدیریت ووکامرس'],
    ['en', 'fa', 'WooCommerce Management'],
  ]) {
    const calls = [];
    const bot = createBot(BOT_TOKEN, {
      backend: {
        status: async () => readyStatus(tenantLanguage),
      },
    });
    installApiStub(bot, calls);

    await bot.handleUpdate(commandUpdate(100, '/start', clientLanguage));

    const message = calls.find((call) => call.method === 'sendMessage');
    assert.match(message.payload.text, new RegExp(expected));
  }
});

test('pre-context start recovery is Persian', async () => {
  const calls = [];
  const bot = createBot(BOT_TOKEN, {
    backend: {
      status: async () => {
        throw new Error('unavailable');
      },
    },
  });
  installApiStub(bot, calls);

  await bot.handleUpdate(commandUpdate(110, '/start', 'en'));

  const message = calls.find((call) => call.method === 'sendMessage');
  assert.match(message.payload.text, /سرویس موقتاً در دسترس نیست/);
});

test('language mutation immediately renders and installs the resulting language', async () => {
  for (const [language, expectedTitle, expectedCommand] of [
    ['fa', 'تنظیمات فروشگاه', 'سفارش‌های اخیر'],
    ['en', 'Store Settings', 'Open recent orders'],
  ]) {
    const calls = [];
    const bot = createBot(BOT_TOKEN, {
      backend: {
        applySettingsAction: async () => settingsResult(language),
      },
    });
    installApiStub(bot, calls);

    await bot.handleUpdate(
      callbackUpdate(language === 'fa' ? 120 : 121, `sg:${SETTINGS_REF}`)
    );

    const edit = calls.find((call) => call.method === 'editMessageText');
    assert.match(edit.payload.text, new RegExp(expectedTitle));
    const commandCall = calls.find((call) => call.method === 'setMyCommands');
    assert.equal(
      commandCall.payload.commands.find(({ command }) => command === 'orders')
        .description,
      expectedCommand
    );
  }
});

test('M13 and M19 semantic notifications render fa/en without changing callbacks', () => {
  for (const language of ['fa', 'en']) {
    const order = renderPreparedNotification({
      chatId: '2001',
      presentation: { language, timezone: 'Asia/Tehran' },
      notification: {
        type: 'ORDER_CREATED',
        orderNumber: '101',
        status: 'processing',
        currency: 'IRR',
        total: '1000',
        customerDisplayName: 'Test Customer',
        viewOrderRef: ORDER_REF,
        changeStatusAvailable: true,
      },
    });
    assert.match(
      order.text,
      new RegExp(language === 'fa' ? 'سفارش تازه' : 'New Order')
    );
    assert.match(order.text, /\u2068101\u2069/);
    assert.deepEqual(
      order.buttons.map(({ callbackData }) => callbackData),
      [ORDER_REF, `t:${ORDER_REF}`]
    );

    for (const type of ['LOW_STOCK', 'OUT_OF_STOCK']) {
      const inventory = renderPreparedNotification({
        chatId: '2001',
        presentation: { language, timezone: 'Asia/Tehran' },
        notification: {
          type,
          displayName: 'Fixture item',
          sku: 'SKU-1',
          quantity: '2',
          stockStatus: 'instock',
          threshold: 5,
          viewStockRef: STOCK_REF,
        },
      });
      assert.match(inventory.text, /\u2068SKU-1\u2069/);
      assert.deepEqual(
        inventory.buttons.map(({ callbackData }) => callbackData),
        [STOCK_REF]
      );
      assert.match(
        inventory.text,
        new RegExp(
          language === 'fa'
            ? type === 'LOW_STOCK'
              ? 'هشدار کم‌موجودی'
              : 'هشدار ناموجودی'
            : type === 'LOW_STOCK'
              ? 'Low Stock'
              : 'Out of Stock'
        )
      );
    }
  }
});

test('representative protected M10-M20 renderers consume Persian presentation metadata', () => {
  const presentation = { language: 'fa', timezone: 'Asia/Tehran' };
  const freshness = { asOf: '2026-09-03T10:00:00.000Z', delayed: false };
  const order = {
    orderNumber: '1001',
    status: 'processing',
    currency: 'IRR',
    totals: { total: '120000' },
    customerDisplayName: 'مشتری نمونه',
    lineItems: [{ name: 'کالا', quantity: 2, total: '120000' }],
    wcCreatedAt: '2026-09-03T09:00:00.000Z',
    wcModifiedAt: '2026-09-03T10:00:00.000Z',
    remoteDeleted: false,
  };

  assert.match(
    renderStatus({
      linked: true,
      authorized: true,
      selectionRequired: false,
      activeTenantId: 'ten_a',
      activeStoreId: 'sto_a',
      presentation,
    }),
    /متصل و مجاز/
  );
  assert.match(
    renderOrderList({
      state: 'OK',
      orders: [
        {
          ref: ORDER_REF,
          orderNumber: '1001',
          status: 'processing',
          currency: 'IRR',
          total: '120000',
          customerDisplayName: 'مشتری نمونه',
          wcCreatedAt: order.wcCreatedAt,
          remoteDeleted: false,
        },
      ],
      nextCursor: null,
      previousCursor: null,
      freshness,
      presentation,
    }).text,
    /سفارش‌های اخیر/
  );
  assert.match(
    renderOrderDetail({
      state: 'OK',
      order,
      backCursor: null,
      transitionsRef: ORDER_REF,
      freshness,
      presentation,
    }).text,
    /وضعیت: در حال انجام/
  );
  assert.match(
    renderStockList({
      state: 'OK',
      items: [
        {
          ref: STOCK_REF,
          displayName: 'کالای نمونه',
          sku: 'SKU-1',
          quantity: '2',
          stockStatus: 'instock',
          classification: 'LOW_STOCK',
          kind: 'PRODUCT',
        },
      ],
      nextCursor: null,
      previousCursor: null,
      threshold: 5,
      presentation,
    }).text,
    /موجودی/
  );
  assert.match(
    renderStockDetail({
      state: 'OK',
      item: {
        displayName: 'کالای نمونه',
        sku: 'SKU-1',
        quantity: '2',
        stockStatus: 'instock',
        classification: 'LOW_STOCK',
        kind: 'PRODUCT',
        variationContext: [],
        threshold: 5,
        lastSyncedAt: '2026-09-03T10:00:00.000Z',
      },
      backCursor: `k.${'g'.repeat(16)}.${'h'.repeat(16)}`,
      presentation,
    }).text,
    /شناسه کالا: \u2068SKU-1\u2069/
  );
  assert.match(
    renderSearch({
      state: 'OK',
      results: [
        {
          ref: `u.${'i'.repeat(16)}.${'j'.repeat(16)}`,
          kind: 'ORDER',
          orderNumber: '1001',
          status: 'processing',
          customerDisplayName: 'مشتری نمونه',
          currency: 'IRR',
          total: '120000',
        },
      ],
      nextCursor: null,
      previousCursor: null,
      inventoryState: 'READY',
      presentation,
    }).text,
    /نتایج جست‌وجو/
  );
  assert.match(
    renderDailyReport({
      state: 'OK',
      localDate: '2026-09-03',
      dayStartUtc: '2026-09-02T20:30:00.000Z',
      nextDayStartUtc: '2026-09-03T20:30:00.000Z',
      timezone: 'Asia/Tehran',
      ordersToday: 1,
      statuses: [{ status: 'processing', count: 1 }],
      sales: [],
      omittedRevenueOrders: 0,
      inventory: { state: 'READY', lowStock: 1, outOfStock: 0 },
      projection: { asOf: null, delayed: false },
      presentation,
    }).text,
    /گزارش عملیاتی روزانه/
  );
  assert.match(renderSettings(settingsResult('fa')).text, /تنظیمات فروشگاه/);
  assert.match(
    renderOrderNoteOptions(
      {
        state: 'OK',
        ref: ORDER_REF,
        visibilities: ['INTERNAL', 'CUSTOMER'],
        presentation,
      },
      ORDER_REF
    ).text,
    /افزودن یادداشت سفارش/
  );
  assert.match(
    renderOrderTransitions(
      {
        state: 'OK',
        ref: `s.${'k'.repeat(16)}.${'l'.repeat(16)}`,
        currentStatus: 'processing',
        targets: ['completed'],
        presentation,
      },
      ORDER_REF
    ).text,
    /تغییر وضعیت/
  );
});

function readyStatus(language) {
  return {
    linked: true,
    authorized: true,
    membershipState: 'active',
    activeTenantId: 'ten_a',
    activeStoreId: 'sto_a',
    tenantSelectionRequired: false,
    storeSelectionRequired: false,
    selectionRequired: false,
    presentation: { language, timezone: 'Asia/Tehran' },
  };
}

function settingsResult(language) {
  return {
    state: 'OK',
    settings: {
      language: language.toUpperCase(),
      timezone: 'Asia/Tehran',
      lowStockThreshold: null,
      enabledNotificationCategories: ['ORDER_CREATED'],
      recipientMode: 'ALL_ELIGIBLE',
      selectedRecipientCount: 0,
      availableRecipientCount: 1,
      editable: false,
      recipients: [],
    },
    presentation: { language, timezone: 'Asia/Tehran' },
  };
}

function commandUpdate(updateId, text, languageCode) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 1001, type: 'private', first_name: 'Test' },
      from: {
        id: 1001,
        is_bot: false,
        first_name: 'Test',
        language_code: languageCode,
      },
      text,
      entities: [
        { offset: 0, length: text.split(' ')[0].length, type: 'bot_command' },
      ],
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
        text: 'Settings',
      },
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
    if (method === 'answerCallbackQuery' || method === 'setMyCommands') {
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
