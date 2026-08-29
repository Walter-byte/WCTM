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
$GLOBALS['wctm_topics'] = array('order.created', 'order.updated', 'order.deleted', 'order.restored');
$GLOBALS['wctm_webhooks'] = array();
$GLOBALS['wctm_health_calls'] = 0;
$GLOBALS['wctm_health_before_reconciliation'] = false;
$GLOBALS['wctm_create_calls'] = 0;
$GLOBALS['wctm_delete_calls'] = 0;

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
function is_wp_error($value): bool { return false; }
function wp_remote_retrieve_response_code(array $response): int { return $response['response']['code']; }
function wp_remote_retrieve_body(array $response): string { return $response['body']; }

function wp_safe_remote_post(string $url, array $args): array
{
    ++$GLOBALS['wctm_health_calls'];
    $expected_url = $GLOBALS['wctm_runtime_base_url'] . '/api/webhooks/woocommerce/' .
        $GLOBALS['wctm_options']['wc_telegram_connector_webhook_endpoint_key'];
    $expected_secret = $GLOBALS['wctm_options']['wc_telegram_connector_webhook_secret'];
    foreach ($GLOBALS['wctm_topics'] as $topic) {
        $matches = array_filter(
            $GLOBALS['wctm_webhooks'],
            static fn (array $webhook): bool => $webhook['name'] === 'WCTM Connector: ' . $topic
        );
        if (count($matches) !== 1) {
            $GLOBALS['wctm_health_before_reconciliation'] = true;
            break;
        }
        $webhook = array_values($matches)[0];
        if ($webhook['topic'] !== $topic || $webhook['status'] !== 'active' ||
            $webhook['delivery_url'] !== $expected_url || $webhook['secret'] !== $expected_secret) {
            $GLOBALS['wctm_health_before_reconciliation'] = true;
            break;
        }
    }
    if (!str_ends_with($url, '/api/plugin/connection-health') ||
        $GLOBALS['wctm_health_before_reconciliation']) {
        return array('response' => array('code' => 500), 'body' => '{}');
    }
    return array('response' => array('code' => 200), 'body' => '{"status":"ACTIVE","healthy":true}');
}

final class WC_Webhook_Data_Store_Fixture
{
    public function get_webhooks_ids(): array
    {
        return array_keys($GLOBALS['wctm_webhooks']);
    }
}

final class WC_Data_Store
{
    private WC_Webhook_Data_Store_Fixture $data_store;

    private function __construct()
    {
        $this->data_store = new WC_Webhook_Data_Store_Fixture();
    }

    public static function load(string $name): self
    {
        if ($name !== 'webhook') {
            throw new RuntimeException('Unexpected data store');
        }
        return new self();
    }

    public function __call(string $name, array $arguments)
    {
        return $this->data_store->{$name}(...$arguments);
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
            ++$GLOBALS['wctm_create_calls'];
            $ids = array_keys($GLOBALS['wctm_webhooks']);
            $this->id = $ids === array() ? 1 : max($ids) + 1;
        }
        $GLOBALS['wctm_webhooks'][$this->id] = $this->data;
        return $this->id;
    }

    public function delete(bool $force_delete = false): void
    {
        ++$GLOBALS['wctm_delete_calls'];
        unset($GLOBALS['wctm_webhooks'][$this->id]);
    }
}

function wc_get_webhook(int $id): ?WC_Webhook
{
    return isset($GLOBALS['wctm_webhooks'][$id]) ? new WC_Webhook($id) : null;
}

$unrelated = array(
    1 => array(
        'name' => 'Inventory integration',
        'topic' => 'product.updated',
        'status' => 'active',
        'delivery_url' => 'https://inventory.example.com/hooks/products',
        'secret' => 'inventory-secret',
        'user_id' => 3,
    ),
    2 => array(
        'name' => 'Accounting integration',
        'topic' => 'order.created',
        'status' => 'paused',
        'delivery_url' => 'https://accounting.example.com/hooks/orders',
        'secret' => 'accounting-secret',
        'user_id' => 4,
    ),
    3 => array(
        'name' => 'Legacy custom delivery',
        'topic' => 'order.updated',
        'status' => 'active',
        'delivery_url' => 'https://wctm.walterbyte.com/api/webhooks/woocommerce/unrelated',
        'secret' => 'legacy-secret',
        'user_id' => 5,
    ),
    4 => array(
        'name' => 'Fulfilment integration',
        'topic' => 'order.deleted',
        'status' => 'disabled',
        'delivery_url' => 'https://fulfilment.example.com/hooks/orders',
        'secret' => 'fulfilment-secret',
        'user_id' => 6,
    ),
);
$GLOBALS['wctm_webhooks'] = $unrelated;
$survivor_ids = array();
$next_id = 11;
foreach ($GLOBALS['wctm_topics'] as $topic) {
    $survivor_ids[$topic] = $next_id;
    for ($copy = 0; $copy < 3; ++$copy) {
        $GLOBALS['wctm_webhooks'][$next_id] = array(
            'name' => 'WCTM Connector: ' . $topic,
            'topic' => $topic,
            'status' => $copy === 0 ? 'paused' : 'active',
            'delivery_url' => $copy === 2
                ? 'https://connector.wctm.walterbyte.com/api/webhooks/woocommerce/stale-key'
                : 'https://wctm.walterbyte.com/api/webhooks/woocommerce/old-key',
            'secret' => $copy === 1 ? 'admin-ui-regenerated-secret' : 'stale-secret',
            'user_id' => 7,
        );
        ++$next_id;
    }
}

$proxy = WC_Data_Store::load('webhook');
if (method_exists($proxy, 'get_webhooks_ids') || count($proxy->get_webhooks_ids()) !== 16) {
    throw new RuntimeException('Fixture does not reproduce WooCommerce proxy enumeration');
}

require dirname(__DIR__, 3) . '/wp-content/plugins/wc-telegram-connector.php';

if (count(wc_telegram_connector_load_webhooks()) !== 16) {
    throw new RuntimeException('Connector loader did not enumerate through the WooCommerce proxy');
}

if (!wc_telegram_connector_install_and_confirm_webhooks()) {
    throw new RuntimeException('Initial duplicate reconciliation did not become healthy');
}

$expected_url = 'https://connector.wctm.walterbyte.com/api/webhooks/woocommerce/' .
    $GLOBALS['wctm_options']['wc_telegram_connector_webhook_endpoint_key'];
$expected_secret = $GLOBALS['wctm_options']['wc_telegram_connector_webhook_secret'];
foreach ($GLOBALS['wctm_topics'] as $topic) {
    $matches = array_filter(
        $GLOBALS['wctm_webhooks'],
        static fn (array $webhook): bool => $webhook['name'] === 'WCTM Connector: ' . $topic
    );
    if (count($matches) !== 1 || !isset($GLOBALS['wctm_webhooks'][$survivor_ids[$topic]])) {
        throw new RuntimeException('Reconciliation did not retain the lowest connector webhook ID');
    }
    $webhook = array_values($matches)[0];
    if ($webhook['topic'] !== $topic || $webhook['status'] !== 'active' ||
        $webhook['delivery_url'] !== $expected_url || $webhook['secret'] !== $expected_secret) {
        throw new RuntimeException('A connector survivor was not fully reconciled');
    }
}
foreach ($unrelated as $id => $webhook) {
    if (($GLOBALS['wctm_webhooks'][$id] ?? null) !== $webhook) {
        throw new RuntimeException('An unrelated webhook was changed');
    }
}
if (count($GLOBALS['wctm_webhooks']) !== 8 || $GLOBALS['wctm_create_calls'] !== 0 ||
    $GLOBALS['wctm_delete_calls'] !== 8 || $GLOBALS['wctm_health_before_reconciliation']) {
    throw new RuntimeException('Duplicate reconciliation did not reach the expected boundary');
}

$after_first_retry = $GLOBALS['wctm_webhooks'];
if (!wc_telegram_connector_install_and_confirm_webhooks() ||
    $after_first_retry !== $GLOBALS['wctm_webhooks'] || $GLOBALS['wctm_create_calls'] !== 0 ||
    $GLOBALS['wctm_delete_calls'] !== 8 || $GLOBALS['wctm_health_calls'] !== 2) {
    throw new RuntimeException('Second Retry changed webhook count or identity');
}

echo "PASS\n";
