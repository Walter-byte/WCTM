<?php
/**
 * Plugin Name: WC Telegram Connector
 * Description: Lightweight connector between WooCommerce stores and WCTM.
 * Version: 0.2.1
 * Author: WC-Telegram-SaaS
 * Update URI: https://wctm.walterbyte.com/plugins/wc-telegram-connector/
 * Requires PHP: 8.0
 * Text Domain: wc-telegram-connector
 */

defined('ABSPATH') || exit;

define('WC_TELEGRAM_CONNECTOR_VERSION', '0.2.1');
define('WC_TELEGRAM_CONNECTOR_FILE', __FILE__);
define('WC_TELEGRAM_CONNECTOR_MENU_SLUG', 'wc-telegram-connector');
define('WC_TELEGRAM_CONNECTOR_OPTION_PREFIX', 'wc_telegram_connector_');

if (!defined('WC_TELEGRAM_CONNECTOR_API_BASE_URL')) {
    define('WC_TELEGRAM_CONNECTOR_API_BASE_URL', '');
}

function wc_telegram_connector_check_dependencies(): void
{
    if (class_exists('WooCommerce')) {
        return;
    }

    add_action('admin_notices', static function (): void {
        if (current_user_can('activate_plugins')) {
            echo '<div class="notice notice-error"><p>';
            echo esc_html__('WC Telegram Connector requires WooCommerce to be installed and active.', 'wc-telegram-connector');
            echo '</p></div>';
        }
    });
}
add_action('plugins_loaded', 'wc_telegram_connector_check_dependencies');

function wc_telegram_connector_activate(): void
{
    wc_telegram_connector_store_option('version', WC_TELEGRAM_CONNECTOR_VERSION);
}
register_activation_hook(__FILE__, 'wc_telegram_connector_activate');

function wc_telegram_connector_deactivate(): void
{
    // Persistent connector material is intentionally retained for reactivation.
}
register_deactivation_hook(__FILE__, 'wc_telegram_connector_deactivate');

function wc_telegram_connector_option_name(string $name): string
{
    return WC_TELEGRAM_CONNECTOR_OPTION_PREFIX . $name;
}

/** @param mixed $value */
function wc_telegram_connector_store_option(string $name, $value): bool
{
    $option = wc_telegram_connector_option_name($name);

    if (get_option($option, null) === null) {
        return add_option($option, $value, '', false);
    }

    if (get_option($option) === $value) {
        return true;
    }

    return update_option($option, $value, false);
}

/** @return mixed */
function wc_telegram_connector_read_option(string $name, $default = '')
{
    return get_option(wc_telegram_connector_option_name($name), $default);
}

function wc_telegram_connector_api_base_url(): string
{
    $candidate = apply_filters('wc_telegram_connector_api_base_url', WC_TELEGRAM_CONNECTOR_API_BASE_URL);

    if (!is_string($candidate)) {
        return '';
    }

    $candidate = untrailingslashit(trim($candidate));
    $parts = wp_parse_url($candidate);

    if (!is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || empty($parts['host']) ||
        isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])) {
        return '';
    }

    return $candidate;
}

function wc_telegram_connector_admin_menu(): void
{
    if (class_exists('WooCommerce')) {
        add_submenu_page(
            'woocommerce',
            __('WCTM Connector', 'wc-telegram-connector'),
            __('WCTM Connector', 'wc-telegram-connector'),
            'manage_woocommerce',
            WC_TELEGRAM_CONNECTOR_MENU_SLUG,
            'wc_telegram_connector_render_admin_page'
        );
    }
}
add_action('admin_menu', 'wc_telegram_connector_admin_menu');

function wc_telegram_connector_admin_url(string $status = ''): string
{
    $url = admin_url('admin.php?page=' . WC_TELEGRAM_CONNECTOR_MENU_SLUG);
    return $status === '' ? $url : add_query_arg('wctm_status', $status, $url);
}

function wc_telegram_connector_safe_redirect(string $status): void
{
    wp_safe_redirect(wc_telegram_connector_admin_url($status));
    exit;
}

function wc_telegram_connector_render_admin_page(): void
{
    if (!current_user_can('manage_woocommerce')) {
        wp_die(esc_html__('You are not allowed to manage this connector.', 'wc-telegram-connector'));
    }

    $connected = wc_telegram_connector_has_material();
    $healthy = $connected && wc_telegram_connector_required_webhooks_are_healthy();
    $status = isset($_GET['wctm_status']) ? sanitize_key(wp_unslash($_GET['wctm_status'])) : '';
    ?>
    <div class="wrap">
        <h1><?php echo esc_html__('WCTM Connector', 'wc-telegram-connector'); ?></h1>
        <?php if ($status === 'connected') : ?>
            <div class="notice notice-success"><p><?php echo esc_html__('Store connected and required order webhooks verified.', 'wc-telegram-connector'); ?></p></div>
        <?php elseif ($status === 'webhook_error') : ?>
            <div class="notice notice-error"><p><?php echo esc_html__('Registration succeeded, but required order webhooks could not be verified. Retry setup below.', 'wc-telegram-connector'); ?></p></div>
        <?php elseif ($status === 'registration_error') : ?>
            <div class="notice notice-error"><p><?php echo esc_html__('Connection could not be completed. Issue a new registration token in WCTM and try again.', 'wc-telegram-connector'); ?></p></div>
        <?php endif; ?>

        <?php if (wc_telegram_connector_api_base_url() === '') : ?>
            <div class="notice notice-error"><p><?php echo esc_html__('The WCTM HTTPS service URL is not configured for this connector build.', 'wc-telegram-connector'); ?></p></div>
        <?php endif; ?>

        <?php if ($connected) : ?>
            <h2><?php echo esc_html__('Connected to WCTM', 'wc-telegram-connector'); ?></h2>
            <p><?php echo $healthy
                ? esc_html__('All required WooCommerce order webhooks are active.', 'wc-telegram-connector')
                : esc_html__('The connector is registered, but webhook setup needs attention.', 'wc-telegram-connector'); ?></p>
            <p><?php echo esc_html__('Stored connector and webhook secrets are intentionally hidden.', 'wc-telegram-connector'); ?></p>
            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                <input type="hidden" name="action" value="wc_telegram_connector_retry_webhooks">
                <?php wp_nonce_field('wc_telegram_connector_retry_webhooks'); ?>
                <?php submit_button(__('Retry webhook setup', 'wc-telegram-connector'), 'secondary', 'submit', false); ?>
            </form>
            <p><?php echo esc_html__('If the saved connector credential is rejected, issue a new M7 token in onboarding and reconnect. Existing webhook material is retained during credential rotation.', 'wc-telegram-connector'); ?></p>
        <?php else : ?>
            <h2><?php echo esc_html__('Connect to WCTM', 'wc-telegram-connector'); ?></h2>
            <p><?php echo esc_html__('Paste one M7 registration token. Never enter your WCTM password or WooCommerce REST credentials here.', 'wc-telegram-connector'); ?></p>
        <?php endif; ?>

        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" autocomplete="off">
            <input type="hidden" name="action" value="wc_telegram_connector_connect">
            <?php wp_nonce_field('wc_telegram_connector_connect'); ?>
            <table class="form-table" role="presentation"><tr>
                <th scope="row"><label for="wctm-registration-token"><?php echo esc_html__('M7 registration token', 'wc-telegram-connector'); ?></label></th>
                <td><input id="wctm-registration-token" name="registration_token" type="password" class="regular-text" minlength="32" maxlength="256" required autocomplete="off"></td>
            </tr></table>
            <?php submit_button($connected ? __('Reconnect with new token', 'wc-telegram-connector') : __('Connect to WCTM', 'wc-telegram-connector')); ?>
        </form>
    </div>
    <?php
}

function wc_telegram_connector_has_material(): bool
{
    foreach (array('plugin_credential', 'store_id', 'webhook_secret', 'webhook_endpoint_key') as $name) {
        $value = wc_telegram_connector_read_option($name);
        if (!is_string($value) || $value === '') {
            return false;
        }
    }
    return true;
}

function wc_telegram_connector_handle_connect(): void
{
    if (!current_user_can('manage_woocommerce')) {
        wp_die(esc_html__('You are not allowed to manage this connector.', 'wc-telegram-connector'));
    }

    check_admin_referer('wc_telegram_connector_connect');
    $token = isset($_POST['registration_token']) ? trim((string) wp_unslash($_POST['registration_token'])) : '';

    if (strlen($token) < 32 || strlen($token) > 256) {
        wc_telegram_connector_safe_redirect('registration_error');
    }

    $result = wc_telegram_connector_register($token);
    $token = '';

    if (!is_array($result)) {
        wc_telegram_connector_safe_redirect('registration_error');
    }

    $plugin_credential = $result['pluginCredential'] ?? null;
    $store_id = $result['storeId'] ?? null;
    $existing_store_id = wc_telegram_connector_read_option('store_id');
    $same_store = is_string($store_id) && is_string($existing_store_id) &&
        hash_equals($existing_store_id, $store_id);
    $webhook_secret = $result['webhookSecret'] ??
        ($same_store ? wc_telegram_connector_read_option('webhook_secret') : null);
    $endpoint_key = $result['webhookEndpointKey'] ??
        ($same_store ? wc_telegram_connector_read_option('webhook_endpoint_key') : null);

    if (!wc_telegram_connector_valid_material($plugin_credential, 'plg_') ||
        !is_string($store_id) || $store_id === '' || strlen($store_id) > 64 ||
        !wc_telegram_connector_valid_material($webhook_secret) ||
        !wc_telegram_connector_valid_material($endpoint_key, 'whk_')) {
        wc_telegram_connector_safe_redirect('registration_error');
    }

    $persisted = wc_telegram_connector_store_option('plugin_credential', $plugin_credential) &&
        wc_telegram_connector_store_option('store_id', $store_id) &&
        wc_telegram_connector_store_option('webhook_secret', $webhook_secret) &&
        wc_telegram_connector_store_option('webhook_endpoint_key', $endpoint_key);

    $plugin_credential = $webhook_secret = $endpoint_key = '';

    if (!$persisted || !wc_telegram_connector_install_and_confirm_webhooks()) {
        wc_telegram_connector_safe_redirect('webhook_error');
    }

    wc_telegram_connector_safe_redirect('connected');
}
add_action('admin_post_wc_telegram_connector_connect', 'wc_telegram_connector_handle_connect');

function wc_telegram_connector_handle_retry_webhooks(): void
{
    if (!current_user_can('manage_woocommerce')) {
        wp_die(esc_html__('You are not allowed to manage this connector.', 'wc-telegram-connector'));
    }
    check_admin_referer('wc_telegram_connector_retry_webhooks');
    wc_telegram_connector_safe_redirect(wc_telegram_connector_install_and_confirm_webhooks() ? 'connected' : 'webhook_error');
}
add_action('admin_post_wc_telegram_connector_retry_webhooks', 'wc_telegram_connector_handle_retry_webhooks');

/** @return array<string, mixed>|null */
function wc_telegram_connector_register(string $token): ?array
{
    $base_url = wc_telegram_connector_api_base_url();
    if ($base_url === '') {
        return null;
    }

    $response = wp_safe_remote_post($base_url . '/api/plugin/register', array(
        'timeout' => 20,
        'redirection' => 0,
        'headers' => array('Accept' => 'application/json', 'Content-Type' => 'application/json'),
        'body' => wp_json_encode(array('token' => $token)),
        'data_format' => 'body',
    ));

    if (is_wp_error($response) || wp_remote_retrieve_response_code($response) !== 200) {
        return null;
    }

    $decoded = json_decode(wp_remote_retrieve_body($response), true);
    return is_array($decoded) ? $decoded : null;
}

function wc_telegram_connector_valid_material($value, string $prefix = ''): bool
{
    return is_string($value) && strlen($value) >= 32 && strlen($value) <= 256 &&
        ($prefix === '' || str_starts_with($value, $prefix));
}

function wc_telegram_connector_delivery_url(): string
{
    $base_url = wc_telegram_connector_api_base_url();
    $endpoint_key = wc_telegram_connector_read_option('webhook_endpoint_key');
    if ($base_url === '' || !is_string($endpoint_key) || $endpoint_key === '') {
        return '';
    }
    return $base_url . '/api/webhooks/woocommerce/' . rawurlencode($endpoint_key);
}

/** @return list<string> */
function wc_telegram_connector_required_topics(): array
{
    return array('order.created', 'order.updated', 'order.deleted', 'order.restored');
}

function wc_telegram_connector_webhook_name(string $topic): string
{
    return 'WCTM Connector: ' . $topic;
}

/** @return list<WC_Webhook> */
function wc_telegram_connector_load_webhooks(): array
{
    if (!class_exists('WC_Data_Store') || !function_exists('wc_get_webhook')) {
        return array();
    }

    $data_store = WC_Data_Store::load('webhook');
    if (!is_object($data_store) || !method_exists($data_store, 'get_webhooks_ids')) {
        return array();
    }

    $webhook_ids = $data_store->get_webhooks_ids();
    if (!is_array($webhook_ids)) {
        return array();
    }

    $webhook_ids = array_map('absint', $webhook_ids);
    sort($webhook_ids, SORT_NUMERIC);
    $webhooks = array();
    foreach ($webhook_ids as $webhook_id) {
        if ($webhook_id <= 0) {
            continue;
        }
        $webhook = wc_get_webhook($webhook_id);
        if ($webhook instanceof WC_Webhook) {
            $webhooks[] = $webhook;
        }
    }
    return $webhooks;
}

function wc_telegram_connector_webhook_has_expected_state(
    WC_Webhook $webhook,
    string $topic,
    string $delivery_url,
    string $secret
): bool {
    $data = $webhook->get_data();
    return is_array($data) &&
        ($data['name'] ?? null) === wc_telegram_connector_webhook_name($topic) &&
        ($data['topic'] ?? null) === $topic &&
        ($data['status'] ?? null) === 'active' &&
        ($data['delivery_url'] ?? null) === $delivery_url &&
        is_string($data['secret'] ?? null) && hash_equals($secret, $data['secret']);
}

function wc_telegram_connector_install_and_confirm_webhooks(): bool
{
    $secret = wc_telegram_connector_read_option('webhook_secret');
    $delivery_url = wc_telegram_connector_delivery_url();
    if (!is_string($secret) || $secret === '' || $delivery_url === '') {
        return false;
    }

    try {
        $webhooks = wc_telegram_connector_load_webhooks();
        foreach (wc_telegram_connector_required_topics() as $topic) {
            $name = wc_telegram_connector_webhook_name($topic);
            $webhook = null;
            foreach ($webhooks as $candidate) {
                if ($candidate->get_name() === $name) {
                    $webhook = $candidate;
                    break;
                }
            }
            if (!($webhook instanceof WC_Webhook)) {
                $webhook = new WC_Webhook();
                $webhook->set_user_id(get_current_user_id());
            }
            $webhook->set_name($name);
            $webhook->set_status('active');
            $webhook->set_topic($topic);
            $webhook->set_delivery_url($delivery_url);
            $webhook->set_secret($secret);
            $webhook_id = (int) $webhook->save();
            if ($webhook_id <= 0) {
                return false;
            }
            $saved_webhook = wc_get_webhook($webhook_id);
            if (!($saved_webhook instanceof WC_Webhook) ||
                !wc_telegram_connector_webhook_has_expected_state($saved_webhook, $topic, $delivery_url, $secret)) {
                return false;
            }
        }
    } catch (Throwable $error) {
        return false;
    } finally {
        $secret = '';
    }

    return wc_telegram_connector_required_webhooks_are_healthy() && wc_telegram_connector_confirm_health();
}

function wc_telegram_connector_required_webhooks_are_healthy(): bool
{
    $delivery_url = wc_telegram_connector_delivery_url();
    $secret = wc_telegram_connector_read_option('webhook_secret');
    if ($delivery_url === '' || !is_string($secret) || $secret === '') {
        return false;
    }

    try {
        $webhooks = wc_telegram_connector_load_webhooks();
        foreach (wc_telegram_connector_required_topics() as $topic) {
            $matched = false;
            foreach ($webhooks as $webhook) {
                if (wc_telegram_connector_webhook_has_expected_state($webhook, $topic, $delivery_url, $secret)) {
                    $matched = true;
                    break;
                }
            }
            if (!$matched) {
                return false;
            }
        }
    } catch (Throwable $error) {
        return false;
    } finally {
        $secret = '';
    }
    return true;
}

function wc_telegram_connector_confirm_health(): bool
{
    $base_url = wc_telegram_connector_api_base_url();
    $credential = wc_telegram_connector_read_option('plugin_credential');
    if ($base_url === '' || !is_string($credential) || $credential === '') {
        return false;
    }

    $response = wp_safe_remote_post($base_url . '/api/plugin/connection-health', array(
        'timeout' => 20,
        'redirection' => 0,
        'headers' => array(
            'Accept' => 'application/json',
            'Content-Type' => 'application/json',
            'X-WCTM-Plugin-Credential' => $credential,
        ),
        'body' => '{}',
        'data_format' => 'body',
    ));
    $credential = '';

    if (is_wp_error($response) || wp_remote_retrieve_response_code($response) !== 200) {
        return false;
    }
    $decoded = json_decode(wp_remote_retrieve_body($response), true);
    return is_array($decoded) && ($decoded['status'] ?? null) === 'ACTIVE' && ($decoded['healthy'] ?? null) === true;
}
