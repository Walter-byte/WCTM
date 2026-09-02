const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');

const { InternalDeliveryServer } = require('../dist/internal-delivery.server');

const VIEW_REF = 'd.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBB';
const STOCK_REF = 'v.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDD';

test('private delivery endpoint rejects missing or wrong bot authentication', async () => {
  let sendCount = 0;
  const server = new InternalDeliveryServer(
    { internalApiKey: 'shared-key', internalPort: 0 },
    {
      sendMessage: async () => {
        sendCount += 1;
        return { message_id: 501 };
      },
    }
  );

  await server.start();
  const port = server.address().port;

  try {
    for (const key of [undefined, 'wrong-key']) {
      const response = await fetch(
        `http://127.0.0.1:${port}/internal/send-message`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(key ? { 'x-bot-api-key': key } : {}),
          },
          body: JSON.stringify(preparedMessage()),
        }
      );
      assert.equal(response.status, 401);
    }

    assert.equal(sendCount, 0);
  } finally {
    await server.close();
  }
});

test('authenticated endpoint sends exactly one prepared message with existing callbacks', async () => {
  const calls = [];
  const server = new InternalDeliveryServer(
    { internalApiKey: 'shared-key', internalPort: 0 },
    {
      sendMessage: async (...args) => {
        calls.push(args);
        return { message_id: 501 };
      },
    }
  );

  await server.start();
  const port = server.address().port;

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/internal/send-message`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bot-api-key': 'shared-key',
        },
        body: JSON.stringify(preparedMessage()),
      }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      outcome: 'delivered',
      messageId: '501',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '2001');
    assert.equal(calls[0][1], 'New Order\n#101');
    assert.equal(
      calls[0][2].reply_markup.inline_keyboard[0][0].callback_data,
      VIEW_REF
    );
    assert.equal(
      calls[0][2].reply_markup.inline_keyboard[0][1].callback_data,
      `t:${VIEW_REF}`
    );
  } finally {
    await server.close();
  }
});

test('authenticated endpoint accepts the M19 stock-detail callback', async () => {
  const calls = [];
  const server = new InternalDeliveryServer(
    { internalApiKey: 'shared-key', internalPort: 0 },
    {
      sendMessage: async (...args) => {
        calls.push(args);
        return { message_id: 502 };
      },
    }
  );

  await server.start();
  const port = server.address().port;

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/internal/send-message`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bot-api-key': 'shared-key',
        },
        body: JSON.stringify({
          chatId: '2001',
          text: 'Low Stock\nFixture item',
          buttons: [{ text: 'View Stock', callbackData: STOCK_REF }],
        }),
      }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      outcome: 'delivered',
      messageId: '502',
    });
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0][2].reply_markup.inline_keyboard[0][0].callback_data,
      STOCK_REF
    );
  } finally {
    await server.close();
  }
});

test('M13 bot transport remains free of Prisma and database access', () => {
  const source = readFileSync(
    resolve(__dirname, '..', 'src', 'internal-delivery.server.ts'),
    'utf8'
  ).toLowerCase();

  assert.doesNotMatch(
    source,
    /@prisma\/client|prismaservice|database_url|postgres/
  );
});

function preparedMessage() {
  return {
    chatId: '2001',
    text: 'New Order\n#101',
    buttons: [
      { text: 'View Order', callbackData: VIEW_REF },
      { text: 'Change Status', callbackData: `t:${VIEW_REF}` },
    ],
  };
}
