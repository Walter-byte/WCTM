# WCTM private-pilot privacy information for merchants

**WCTM — Telegram Store Manager for WooCommerce, by Walterbyte** (`https://walterbyte.com`) helps authorized store staff view and manage selected WooCommerce operations in Telegram. This is a product data-flow notice for a controlled private pilot, not a legal certification or a substitute for your store's own privacy notice.

## What the connection processes

When you connect a store, WCTM receives store identity/configuration and WooCommerce REST credentials, then installs authenticated order and product webhooks through its WordPress connector. WooCommerce sends order and product webhook payloads to WCTM. These can contain order numbers, items, totals, customer names, email/phone numbers, billing and shipping addresses, notes, and other fields present in WooCommerce's webhook JSON. WCTM also stores account email, team membership/roles, Telegram user/chat IDs, operational audit/delivery records and integration health information.

The WordPress connector keeps the store ID, connector credential, webhook secret and route key in WordPress options with autoload disabled. WooCommerce webhook records also hold the webhook configuration. The connector does not install tracking cookies or telemetry and does not keep its own local customer/order database. WordPress/WooCommerce and their normal host/database backups remain under the store operator's control.

## Where it goes

WCTM stores account, store, event, order and inventory records in its PostgreSQL service. Its Redis queue holds job identifiers/context and rate-limit state; Redis persistence is enabled. The backend makes authorized WooCommerce REST requests. Only authorized private-chat store managers can request operational views/actions. WCTM sends selected order and inventory details to Telegram to deliver those views and notifications; order detail may include customer name and shipping address. Telegram is an external platform with its own message and account retention behavior. Do not put information in manager notes that staff should not share with Telegram or WooCommerce.

WCTM makes custom-format PostgreSQL backups for recovery. Backup sets have SHA-256 checksums and are copied to OneDrive with remote content verification. The operational default retains 14 valid local sets; repository code does not set an automatic deletion period for OneDrive copies or all application records. Backups contain database data, including personal information. The backup workflow verifies integrity; it does not apply its own encryption to the dump before off-site transfer.

## Security and your responsibilities

WCTM encrypts WooCommerce REST and backend webhook secrets in its database, hashes several connection/link tokens, checks webhook signatures, uses tenant-scoped authorization and restricts production database access. WordPress-side connector and WooCommerce webhook secrets rely on the security of your WordPress database, host, administrators and backups. Keep WordPress/WooCommerce updated, restrict administrator and database access, use HTTPS, and give Telegram manager access only to trusted staff. Telegram messages are outside WCTM's database controls once delivered.

As the store operator, inform customers and staff about the store's use of WCTM and Telegram as appropriate, and handle their access/deletion requests for the WooCommerce data you control. Avoid entering unnecessary personal data in free-form notes. Review your own WordPress/WooCommerce retention and backup settings.

## Disconnecting and requesting deletion

Plugin **deactivation** retains connector settings and WooCommerce webhooks; it does not stop all webhook delivery. The Store `DELETE` operation in WCTM is a **soft delete** that gates active use but retains historical records and encrypted credentials. Confirmed Telegram `/unlink` revokes the active chat link, but prior WCTM and Telegram records remain. Plugin **uninstall** deletes connector options and matching local webhooks when WooCommerce APIs are available; it does not erase WCTM, OneDrive or Telegram data. If WooCommerce was inactive during uninstall, check and remove remaining WCTM webhooks after reactivation. Rotate credentials when a connection is retired or compromised.

For a private-pilot service-side access or deletion request, contact your Walterbyte pilot contact through the agreed support channel and identify your account/store. The team must verify the requester and agree the scope, legal/operational retention and backup handling before performing deletion. An automated complete-erasure process is not yet available; WCTM will not claim that uninstall or soft deletion erases all data. Pilot onboarding must wait for the retention/deletion and backup-access decisions listed in the internal PPR-1 audit.
