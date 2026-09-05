const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const { gzipSync } = require('node:zlib');

const express = require('express');

const { configureBodyParsers } = require('../dist/http/body-parsers');
const {
  signaturesMatch,
} = require('../dist/webhooks/woocommerce-webhook-ingestion.service');

const WEBHOOK_SECRET = 'body-limit-test-webhook-secret';

function signature(body) {
  return createHmac('sha256', WEBHOOK_SECRET).update(body).digest('base64');
}

async function withWebhookServer(run) {
  const application = express();
  let domainProcessingCount = 0;
  let authenticatedBody = null;

  configureBodyParsers(application);
  application.post(
    '/api/webhooks/woocommerce/:endpointKey',
    (request, response) => {
      assert.ok(Buffer.isBuffer(request.body));
      const supplied = Buffer.from(
        String(request.get('x-wc-webhook-signature') ?? ''),
        'base64'
      );
      if (!signaturesMatch(request.body, WEBHOOK_SECRET, supplied)) {
        response.sendStatus(401);
        return;
      }

      domainProcessingCount += 1;
      authenticatedBody = Buffer.from(request.body);
      response.status(200).json({ accepted: true });
    }
  );
  application.use((error, _request, response, _next) => {
    response.status(Number(error.status ?? 500)).json({ error: 'rejected' });
  });

  const server = application.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');

  try {
    await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      processed: () => domainProcessingCount,
      receivedBody: () => authenticatedBody,
    });
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('valid signed webhook below 1 MiB authenticates exact bytes and processes', async () => {
  await withWebhookServer(async ({ baseUrl, processed, receivedBody }) => {
    const body = Buffer.from('{\n  "id": 1, "note": "exact spacing"\n}\n');
    const response = await fetch(
      `${baseUrl}/api/webhooks/woocommerce/whk_test`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-wc-webhook-signature': signature(body),
        },
        body,
      }
    );

    assert.equal(response.status, 200);
    assert.equal(processed(), 1);
    assert.deepEqual(receivedBody(), body);
  });
});

test('oversized raw webhook returns 413 before domain processing', async () => {
  await withWebhookServer(async ({ baseUrl, processed }) => {
    const body = Buffer.alloc(1024 * 1024 + 1, 0x61);
    const response = await fetch(
      `${baseUrl}/api/webhooks/woocommerce/whk_test`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-wc-webhook-signature': signature(body),
        },
        body,
      }
    );

    assert.equal(response.status, 413);
    assert.equal(processed(), 0);
  });
});

test('compressed webhook cannot inflate through the raw-body limit', async () => {
  await withWebhookServer(async ({ baseUrl, processed }) => {
    const expanded = Buffer.alloc(1024 * 1024 + 1, 0x61);
    const compressed = gzipSync(expanded);
    const response = await fetch(
      `${baseUrl}/api/webhooks/woocommerce/whk_test`,
      {
        method: 'POST',
        headers: {
          'content-encoding': 'gzip',
          'content-type': 'application/json',
          'x-wc-webhook-signature': signature(expanded),
        },
        body: compressed,
      }
    );

    assert.equal(response.status, 415);
    assert.equal(processed(), 0);
  });
});
