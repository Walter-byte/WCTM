<?php
/**
 * Plugin Name: WC Telegram Connector
 * Description: Lightweight connector between WooCommerce stores and WC-Telegram-SaaS.
 * Version: 0.1.0
 * Author: WC-Telegram-SaaS
 * Requires PHP: 8.0
 * Text Domain: wc-telegram-connector
 */

defined('ABSPATH') || exit;

define('WC_TELEGRAM_CONNECTOR_VERSION', '0.1.0');
define('WC_TELEGRAM_CONNECTOR_FILE', __FILE__);

/**
 * Verify that WooCommerce is available before the connector initializes.
 */
function wc_telegram_connector_check_dependencies(): void
{
    if (class_exists('WooCommerce')) {
        return;
    }

    add_action(
        'admin_notices',
        static function (): void {
            if (!current_user_can('activate_plugins')) {
                return;
            }

            echo '<div class="notice notice-error"><p>';
            echo esc_html__(
                'WC Telegram Connector requires WooCommerce to be installed and active.',
                'wc-telegram-connector'
            );
            echo '</p></div>';
        }
    );
}
add_action('plugins_loaded', 'wc_telegram_connector_check_dependencies');

/**
 * Reserve the activation hook for future connection setup.
 */
function wc_telegram_connector_activate(): void
{
    update_option('wc_telegram_connector_version', WC_TELEGRAM_CONNECTOR_VERSION);
}
register_activation_hook(__FILE__, 'wc_telegram_connector_activate');

/**
 * Reserve the deactivation hook for future cleanup.
 */
function wc_telegram_connector_deactivate(): void
{
    // Persistent connection data is intentionally preserved on deactivation.
}
register_deactivation_hook(__FILE__, 'wc_telegram_connector_deactivate');
