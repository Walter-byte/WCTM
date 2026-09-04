const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
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
  assert.match(plugin, /preg_match\('\/\\Areg_\[A-Za-z0-9_-\]\{43\}\\z\/D'/);
});

test('connector admin mutations require WooCommerce capability and WordPress nonces', () => {
  for (const action of ['connect', 'retry_webhooks']) {
    assert.match(
      plugin,
      new RegExp(
        `function wc_telegram_connector_handle_${action}\\(\\): void[\\s\\S]*?current_user_can\\('manage_woocommerce'\\)[\\s\\S]*?check_admin_referer\\('wc_telegram_connector_${action}'\\)`
      )
    );
    assert.match(
      plugin,
      new RegExp(`wp_nonce_field\\('wc_telegram_connector_${action}'\\)`)
    );
  }
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

test('connector installs and verifies every required order and inventory webhook before health confirmation', () => {
  for (const topic of [
    'order.created',
    'order.updated',
    'order.deleted',
    'order.restored',
    'product.created',
    'product.updated',
    'product.deleted',
    'product.restored',
  ]) {
    assert.match(plugin, new RegExp(topic.replace('.', '\\.')));
  }
  assert.match(plugin, /set_status\('active'\)/);
  assert.match(plugin, /set_delivery_url\(\$delivery_url\)/);
  assert.match(plugin, /set_secret\(\$secret\)/);
  assert.match(plugin, /WC_Data_Store::load\('webhook'\)/);
  assert.match(plugin, /get_webhooks_ids\(\)/);
  assert.doesNotMatch(plugin, /method_exists\([^\n]*get_webhooks_ids/);
  assert.match(plugin, /wc_get_webhook\(\$webhook_id\)/);
  assert.doesNotMatch(plugin, /wc_get_webhooks\(/);
  assert.match(plugin, /\(\$data\['name'\] \?\? null\) === \$name/);
  assert.match(plugin, /\$saved_webhook = wc_get_webhook\(\$webhook_id\)/);
  assert.match(plugin, /\$duplicate->delete\(true\)/);
  assert.match(plugin, /count\(\$owned\) !== 1/);
  assert.match(plugin, /hash_equals\(\$secret, \$data\['secret'\]\)/);
  assert.match(
    plugin,
    /required_webhooks_are_healthy\(\) && wc_telegram_connector_confirm_health\(\)/
  );
  assert.match(plugin, /\/api\/plugin\/connection-health/);
  assert.match(plugin, /X-WCTM-Plugin-Credential/);
});

test('connector declares a private Update URI without implementing an updater', () => {
  assert.match(
    plugin,
    /\* Update URI: https:\/\/wctm\.walterbyte\.com\/plugins\/wc-telegram-connector\//
  );
  assert.doesNotMatch(plugin, /pre_set_site_transient_update_plugins/);
  assert.doesNotMatch(plugin, /plugins_api/);
});

const php = spawnSync('php', ['-v'], { encoding: 'utf8' });
test(
  'retry enumerates proxied hooks, collapses duplicates, and restores the persisted M8 secret',
  {
    skip: php.error || php.status !== 0 ? 'PHP runtime is unavailable' : false,
  },
  () => {
    const result = spawnSync(
      'php',
      [join(__dirname, 'fixtures/wordpress-plugin-reconciliation.php')],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /^PASS\s*$/);
  }
);

test('connector keeps secrets out of navigation URLs and provides new-token reconnect guidance', () => {
  assert.doesNotMatch(
    plugin,
    /add_query_arg\([^\n]*(?:token|credential|secret)/i
  );
  assert.match(plugin, /issue a new M7 token/i);
  assert.match(plugin, /Reconnect with new token/);
  assert.match(plugin, /redirection' => 0/);
});
