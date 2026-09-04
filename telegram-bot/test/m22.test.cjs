const assert = require('node:assert/strict');
const test = require('node:test');

const {
  renderOrderList,
  renderSettings,
  renderStatus,
} = require('../dist/bot.js');
const { InternalBackendClient } = require('../dist/internal-backend.client.js');

const suspended = {
  plan: 'PRO',
  status: 'SUSPENDED',
  effectiveState: 'SUSPENDED',
  expiresAt: null,
};

const expired = {
  plan: 'FREE',
  status: 'ACTIVE',
  effectiveState: 'EXPIRED',
  expiresAt: '2026-09-04T08:00:00.000Z',
};

test('inactive operational outcomes parse and render localized recovery only', async () => {
  const request = async () =>
    new Response(
      JSON.stringify({
        state: 'ENTITLEMENT_INACTIVE',
        presentation: {
          language: 'en',
          timezone: 'Asia/Tehran',
          entitlement: suspended,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  const client = new InternalBackendClient(
    {
      internalApiKey: 'bot-key',
      backendInternalUrl: 'http://backend/api',
      backendTimeoutMs: 5000,
      statusWriteTimeoutMs: 50000,
    },
    request
  );

  const result = await client.listOrders({
    telegramUserId: '1001',
    telegramChatId: '2001',
    updateId: '3001',
  });
  const rendered = renderOrderList(result);

  assert.equal(result.state, 'ENTITLEMENT_INACTIVE');
  assert.match(rendered.text, /Service access is suspended/);
  assert.match(rendered.text, /Plan: Pro/);
  assert.doesNotMatch(rendered.text, /ten_|sto_|1001|2001/);
});

test('Persian expired status uses Tenant-timezone Persian-calendar presentation', () => {
  const text = renderStatus({
    linked: true,
    authorized: true,
    selectionRequired: false,
    activeTenantId: 'opaque',
    activeStoreId: 'opaque',
    entitlement: expired,
    presentation: {
      language: 'fa',
      timezone: 'Asia/Tehran',
      entitlement: expired,
    },
  });

  assert.match(text, /دسترسی سرویس منقضی شده است/);
  assert.match(text, /طرح: رایگان/);
  assert.match(text, /۱۴۰۵/);
});

test('inactive settings remain readable and contain no mutation references', () => {
  const rendered = renderSettings({
    state: 'OK',
    presentation: {
      language: 'en',
      timezone: 'UTC',
      entitlement: suspended,
    },
    settings: {
      entitlement: suspended,
      language: 'EN',
      timezone: 'UTC',
      lowStockThreshold: 5,
      enabledNotificationCategories: ['ORDER_CREATED', 'LOW_STOCK'],
      recipientMode: 'ALL_ELIGIBLE',
      selectedRecipientCount: 0,
      availableRecipientCount: 1,
      editable: false,
      recipients: [],
    },
  });

  assert.match(rendered.text, /Settings are read-only while service access is inactive/);
  assert.doesNotMatch(JSON.stringify(rendered.keyboard.inline_keyboard), /sg:|si:|g\./);
});
