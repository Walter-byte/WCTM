const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const plugin = readFileSync(
  join(__dirname, '../../wp-content/plugins/wc-telegram-connector.php'),
  'utf8'
);

test('connector accepts only the M7 token and derives identity from its response', () => {
  assert.match(plugin, /wp_json_encode\(array\('token' => \$token\)\)/);
  assert.match(plugin, /\$result\['pluginCredential'\]/);
  assert.match(plugin, /\$result\['storeId'\]/);
  assert.doesNotMatch(plugin, /name="(?:username|email|tenant_id|store_id)"/i);
  assert.doesNotMatch(plugin, /WCTM.*password[^\n]*<input/i);
});

test('connector stores sensitive material with autoload disabled and never renders it', () => {
  assert.match(plugin, /add_option\(\$option, \$value, '', false\)/);
  assert.match(plugin, /update_option\(\$option, \$value, false\)/);
  for (const option of [
    'plugin_credential',
    'webhook_secret',
    'webhook_endpoint_key',
  ]) {
    assert.match(plugin, new RegExp(`store_option\\('${option}'`));
  }
  assert.doesNotMatch(
    plugin,
    /echo\s+[^;]*(?:plugin_credential|webhook_secret|endpoint_key)/i
  );
  assert.doesNotMatch(plugin, /error_log|trigger_error/);
});

test('connector installs and verifies every required order webhook before health confirmation', () => {
  for (const topic of [
    'order.created',
    'order.updated',
    'order.deleted',
    'order.restored',
  ]) {
    assert.match(plugin, new RegExp(topic.replace('.', '\\.')));
  }
  assert.match(plugin, /set_status\('active'\)/);
  assert.match(plugin, /set_delivery_url\(\$delivery_url\)/);
  assert.match(plugin, /set_secret\(\$secret\)/);
  assert.match(
    plugin,
    /required_webhooks_are_healthy\(\) && wc_telegram_connector_confirm_health\(\)/
  );
  assert.match(plugin, /\/api\/plugin\/connection-health/);
  assert.match(plugin, /X-WCTM-Plugin-Credential/);
});

test('connector keeps secrets out of navigation URLs and provides new-token reconnect guidance', () => {
  assert.doesNotMatch(
    plugin,
    /add_query_arg\([^\n]*(?:token|credential|secret)/i
  );
  assert.match(plugin, /issue a new M7 token/i);
  assert.match(plugin, /Reconnect with new token/);
  assert.match(plugin, /redirection' => 0/);
});
