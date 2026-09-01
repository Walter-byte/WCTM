=== WC Telegram Connector ===
Contributors: wc-telegram-saas
Tags: woocommerce, telegram, connector, automation
Requires PHP: 8.0
Stable tag: 0.3.0

Lightweight connector between WooCommerce stores and WC-Telegram-SaaS.

== Description ==

WC Telegram Connector provides the WordPress-side foundation for securely
connecting a WooCommerce store to WC-Telegram-SaaS.

Version 0.3.0 extends the M16 onboarding connector for M19. It redeems one M7 token,
stores connector material with autoload disabled, installs and verifies the
four required WooCommerce order webhooks plus the four core product webhooks,
and confirms safe health to WCTM.

== Installation ==

1. Copy the connector files from this repository's `wp-content/plugins`
   directory to `/wp-content/plugins/wc-telegram-connector` in the WordPress
   installation.
2. Ensure WooCommerce is installed and active.
3. Activate WC Telegram Connector from the WordPress Plugins screen.
4. Set `WC_TELEGRAM_CONNECTOR_API_BASE_URL` to the connector's public WCTM
   HTTPS origin in the deployed connector build or WordPress configuration.
   Production currently uses `https://connector.wctm.walterbyte.com`.
5. Open WooCommerce → WCTM Connector and paste the one-time registration token
   issued by WCTM onboarding.

== Frequently Asked Questions ==

= Does this plugin require WooCommerce? =

Yes. An administrator notice appears when WooCommerce is not active.

= Does the plugin ask for my WCTM password? =

No. It accepts only a one-time M7 token and never chooses a Tenant or Store.

= Why does the connector use a different production hostname? =

Some Iran-hosted WooCommerce environments cannot reach the Cloudflare-proxied
public application hostname. The connector therefore uses the DNS-only HTTPS
origin `https://connector.wctm.walterbyte.com`; browser onboarding can remain at
`https://wctm.walterbyte.com`. The hostname contains no secret and exposes only
the existing Caddy-routed backend, not PostgreSQL, Redis, or additional ports.

== Changelog ==

= 0.3.0 =

* Reconcile the M19 `product.created`, `product.updated`, `product.deleted`,
  and `product.restored` hooks alongside the existing order hooks.

= 0.2.2 =

* Support WooCommerce's proxied webhook data store and collapse duplicate
  connector-owned hooks during idempotent Retry recovery.

= 0.2.1 =

* Reconcile connector-owned webhooks in place, restore the persisted M8 secret
  during retry, and prevent unrelated WordPress.org update offers.

= 0.2.0 =

* Add M7 registration, secure connector storage, M8 order webhook setup,
  verification, retry, and reconnect guidance.

= 0.1.0 =

* Initial plugin scaffold.
