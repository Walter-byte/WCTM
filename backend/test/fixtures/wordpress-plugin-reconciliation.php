<?php

declare(strict_types=1);

define('ABSPATH', __DIR__);
define('WC_TELEGRAM_CONNECTOR_API_BASE_URL', 'https://unused.example.com');

$GLOBALS['wctm_options'] = array(
    'wc_telegram_connector_plugin_credential' => 'plg_' . str_repeat('p', 40),
    'wc_telegram_connector_store_id' => 'sto_fixture',
    'wc_telegram_connector_webhook_secret' => 'persisted-m8-secret-' . str_repeat('s', 32),
    'wc_telegram_connector_webhook_endpoint_key' => 'whk_' . str_repeat('e', 32),
);
$GLOBALS['wctm_runtime_base_url'] = 'https://connector.wctm.walterbyte.com';
$GLOBALS['wctm_webhooks'] = array();
$GLOBALS['wctm_health_calls'] = 0;

function add_action(): void {}
function register_activation_hook(): void {}
function register_deactivation_hook(): void {}
function apply_filters(string $name, $value)
{
    return $name === 'wc_telegram_connector_api_base_url'
        ? $GLOBALS['wctm_runtime_base_url']
        : $value;
}
function untrailingslashit(string $value): string { return rtrim($value, '/'); }
function wp_parse_url(string $value) { return parse_url($value); }
function get_option(string $name, $default = false)
{
    return $GLOBALS['wctm_options'][$name] ?? $default;
}
function add_option(string $name, $value): bool
{
    $GLOBALS['wctm_options'][$name] = $value;
    return true;
}
function update_option(string $name, $value): bool
{
    $GLOBALS['wctm_options'][$name] = $value;
    return true;
}
function absint($value): int { return abs((int) $value); }
function get_current_user_id(): int { return 7; }
function wp_safe_remote_post(string $url, array $args): array
{
    ++$GLOBALS['wctm_health_calls'];
    return array('response' => array('code' => 200), 'body' => '{"status":"ACTIVE","healthy":true}');
}
function is_wp_error($value): bool { return false; }
function wp_remote_retrieve_response_code(array $response): int { return $response['response']['code']; }
function wp_remote_retrieve_body(array $response): string { return $response['body']; }

final class WC_Webhook_Data_Store_Fixture
{
    public function get_webhooks_ids(): array
    {
        return array_keys($GLOBALS['wctm_webhooks']);
    }
}

final class WC_Data_Store
{
    public static function load(string $name): WC_Webhook_Data_Store_Fixture
    {
        if ($name !== 'webhook') {
            throw new RuntimeException('Unexpected data store');
        }
        return new WC_Webhook_Data_Store_Fixture();
    }
}

class WC_Webhook
{
    private int $id = 0;
    private array $data = array(
        'name' => '',
        'topic' => '',
        'status' => 'disabled',
        'delivery_url' => '',
        'secret' => '',
        'user_id' => 0,
    );

    public function __construct(int $id = 0)
    {
        if ($id > 0 && isset($GLOBALS['wctm_webhooks'][$id])) {
            $this->id = $id;
            $this->data = $GLOBALS['wctm_webhooks'][$id];
        }
    }

    public function get_id(): int { return $this->id; }
    public function get_name(): string { return $this->data['name']; }
    public function get_data(): array { return $this->data; }
    public function set_name(string $value): void { $this->data['name'] = $value; }
    public function set_topic(string $value): void { $this->data['topic'] = $value; }
    public function set_status(string $value): void { $this->data['status'] = $value; }
    public function set_delivery_url(string $value): void { $this->data['delivery_url'] = $value; }
    public function set_secret(string $value): void { $this->data['secret'] = $value; }
    public function set_user_id(int $value): void { $this->data['user_id'] = $value; }

    public function save(): int
    {
        if ($this->id === 0) {
            $this->id = count($GLOBALS['wctm_webhooks']) + 1;
        }
        $GLOBALS['wctm_webhooks'][$this->id] = $this->data;
        return $this->id;
    }
}

function wc_get_webhook(int $id): ?WC_Webhook
{
    return isset($GLOBALS['wctm_webhooks'][$id]) ? new WC_Webhook($id) : null;
}

$topics = array('order.created', 'order.updated', 'order.deleted', 'order.restored');
foreach ($topics as $index => $topic) {
    $GLOBALS['wctm_webhooks'][$index + 11] = array(
        'name' => 'WCTM Connector: ' . $topic,
        'topic' => $topic,
        'status' => 'active',
        'delivery_url' => 'https://wctm.walterbyte.com/api/webhooks/woocommerce/' .
            $GLOBALS['wctm_options']['wc_telegram_connector_webhook_endpoint_key'],
        'secret' => 'admin-ui-regenerated-secret',
        'user_id' => 7,
    );
}

require dirname(__DIR__, 3) . '/wp-content/plugins/wc-telegram-connector.php';

$before_ids = array_keys($GLOBALS['wctm_webhooks']);
if (!wc_telegram_connector_install_and_confirm_webhooks()) {
    throw new RuntimeException('Initial reconciliation did not become healthy');
}

$expected_url = 'https://connector.wctm.walterbyte.com/api/webhooks/woocommerce/' .
    $GLOBALS['wctm_options']['wc_telegram_connector_webhook_endpoint_key'];
$expected_secret = $GLOBALS['wctm_options']['wc_telegram_connector_webhook_secret'];
foreach ($topics as $index => $topic) {
    $webhook = $GLOBALS['wctm_webhooks'][$index + 11] ?? null;
    if (!is_array($webhook) || $webhook['name'] !== 'WCTM Connector: ' . $topic ||
        $webhook['topic'] !== $topic || $webhook['status'] !== 'active' ||
        $webhook['delivery_url'] !== $expected_url || $webhook['secret'] !== $expected_secret) {
        throw new RuntimeException('A connector hook was not fully reconciled');
    }
}
if ($before_ids !== array_keys($GLOBALS['wctm_webhooks'])) {
    throw new RuntimeException('Reconciliation created a duplicate hook');
}

if (!wc_telegram_connector_install_and_confirm_webhooks() ||
    $before_ids !== array_keys($GLOBALS['wctm_webhooks']) || $GLOBALS['wctm_health_calls'] !== 2) {
    throw new RuntimeException('Retry is not idempotent');
}

echo "PASS\n";
