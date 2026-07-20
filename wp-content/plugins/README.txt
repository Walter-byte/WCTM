=== WC Telegram Connector ===
Contributors: wc-telegram-saas
Tags: woocommerce, telegram, connector, automation
Requires PHP: 8.0
Stable tag: 0.1.0

Lightweight connector between WooCommerce stores and WC-Telegram-SaaS.

== Description ==

WC Telegram Connector provides the WordPress-side foundation for securely
connecting a WooCommerce store to WC-Telegram-SaaS.

Version 0.1.0 contains activation, deactivation, and dependency-check stubs
only. Store registration and webhook management arrive in a later phase.

== Installation ==

1. Copy the connector files from this repository's `wp-content/plugins`
   directory to `/wp-content/plugins/wc-telegram-connector` in the WordPress
   installation.
2. Ensure WooCommerce is installed and active.
3. Activate WC Telegram Connector from the WordPress Plugins screen.

== Frequently Asked Questions ==

= Does this plugin require WooCommerce? =

Yes. An administrator notice appears when WooCommerce is not active.

= Does this version connect to Telegram? =

No. This scaffold does not contain business logic or external API calls.

== Changelog ==

= 0.1.0 =

* Initial plugin scaffold.
