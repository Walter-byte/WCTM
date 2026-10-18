# Representative-site connector privacy validation

Status: procedure designed from existing primitives; **actual-site acceptance
not executed**. Use only an explicitly authorized disposable WordPress/WooCommerce
site, synthetic orders/products, and an isolated WCTM Tenant/Store. No merchant
site or production credentials. Record versions, webhook IDs, request IDs and
PASS/FAIL outcomes; never credential values, route keys, customer payloads or
usable URLs.

## Prerequisites and salt-loss fixture

Require a protected site/database backup, recorded current/original installation
salts where recoverable, WP-CLI with the connector loaded, WooCommerce webhook
CRUD APIs, an OWNER/ADMIN session scoped to the exact active WCTM Tenant/Store,
a valid entitlement, and a protected local recovery directory outside the web
root (0700; files 0600). The operator must control the maintenance window, stop
synthetic event generation and cron/queued webhook delivery during rotation,
and prevent application processing during any database restore. An available
site must be independently authorized; a cached PHP image is not a site.

1. Connect through M7; verify encrypted WCTM credential/secret options with
   autoload disabled, no secret rendering/logging, and all eight required hooks
   with exact name, topic, route and signing secret.
2. Add unrelated hooks with similar names and another origin. Also test an
   exact canonical-name collision separately; recovery must stop before setup
   in this case, preserving the unrelated hook.
3. Change `AUTH_KEY` and `SECURE_AUTH_KEY` only on this disposable site. Confirm
   stored credentials fail to decrypt and Retry creates/modifies no hooks.
4. Restore original constants and verify recovery without credential rotation.
   Repeat lost salts; confirm fresh M7 alone cannot recover the M8 signing
   secret. M7 returns existing Store material only when newly provisioned.
5. Independently test deactivation (retains configuration/hooks) and uninstall
   under unreadable secrets (removes only exact old URL/topic/name hooks and
   WCTM options). Enumerate hooks afterward: uninstall catches errors, so a
   successful invocation is insufficient evidence of cleanup.

## Permanently lost salts: same-Store recovery design

This is a bounded operator procedure using existing APIs and PHP helpers,
not a shipped recovery UI. It requires representative-site acceptance before
pilot use. Preserve the existing non-deleted Store and all its history.
`pilot-privacy.sh disconnect` is a privacy cessation operation: it tombstones the
Store. It is unsuitable for routine salt recovery; the unique
`(tenantId, baseUrl)` constraint also blocks a replacement at the same URL.
Do not erase history, edit database rows, change the URL or create another
Tenant to bypass this constraint. Already disconnected/deleted Stores require
an A-owned recovery decision; stop.

1. Confirm request authority and exact Tenant, Store and site origin. Freeze
   events/delivery. Capture the old configured WCTM origin and full old delivery
   URL, Store ID, and a complete webhook inventory into protected local records
   **before** deleting/changing options. `wc_telegram_connector_load_webhooks()`
   enumerates all IDs, including hooks beyond the first page. Confirm all target
   matches are exact `WCTM Connector: <topic>`, required topic and old URL.
   Preserve every other hook. If any unrelated remaining hook has an exact
   canonical name for a required topic, **stop before rotation/installation**:
   setup selects by name, so the owner must resolve the collision separately.
2. Establish valid new host-side salts; verify
   `wc_telegram_connector_secret_key()` is available. Never attempt plaintext
   fallback for unreadable ciphertext. Keep the site backup protected; it
   contains obsolete ciphertext and WooCommerce-owned secrets.
3. Through an authenticated protected HTTP client, in the exact Tenant context,
   POST `/api/stores/<storeId>/webhook-credentials` with `{"rotate":true}`.
   Save the one-time new `webhookSecret` and `webhookEndpointKey` directly into
   a 0600 recovery file; never console, shell arguments, browser storage or
   tickets. Require `provisioned:true`, `rotated:true`, valid new material and
   a route differing from the protected old route. This invalidates old M8
   route/secret for this Store. If the response is lost, stop; obtain a fresh
   authorized rotation rather than recover/reuse an old secret.
4. Remove **only** old hooks matching the protected old URL, exact required
   topic and canonical name through WooCommerce CRUD. Re-enumerate to prove
   zero old exact matches and an unchanged unrelated-hook inventory. Uninstall
   may be used for local-option cleanup only after capturing the old route;
   its swallowed exceptions do not establish removal. Do not clear unrelated
   WooCommerce hooks or the site's WooCommerce data.
5. POST `/api/stores/<storeId>/registration-token` under the same authorized
   session. Capture the new `reg_` token directly into the protected recovery
   file. Finalize M7 with the protected bridge below; successful registration
   replaces the old plugin credential and consumes the token. Issuing the
   token alone does not revoke the old plugin credential. Maintain the
   maintenance window until finalization and negative authentication checks
   succeed. If Woo REST keys are separately being replaced, create test keys,
   PATCH the same Store with the new keys through its authorized API, verify
   connection, then revoke obsolete Woo REST keys in WooCommerce. Never copy
   unreadable WordPress options into WCTM credentials.
6. Use the existing encryption helpers under current salts to store the new
   plugin credential, independently captured M8 secret, same Store ID and new
   route. Do not let M7 fallback silently select old material. Read back each
   new value in memory, check encryption prefix/autoload without printing
   secrets, recheck collisions, then install/confirm all eight hooks. Record
   only safe outcome/IDs. Registration does not itself certify webhook health.
7. Confirm plugin health and authorized Store connection-health. Submit a new
   synthetic signed order and product event; correlate accepted ingress,
   terminal processing, correct Tenant/Store projections and deduplication.
   Prove old plugin credential is rejected, consumed old/new registration
   tokens cannot register again, old route is rejected, and old-secret signed
   payloads on the new route are rejected with no projection/delivery. If the
   old decrypted plugin credential is unavailable, record DB hash replacement
   and old authentication inability separately from an HTTP negative test.
   Compare old/new protected values in memory; log only inequality outcomes.
8. Unfreeze events only after all checks pass; safely dispose of temporary
   tokens/response/recovery files and executable bridge under test-data policy.
   Do not publish exports or leave the bridge in the web root. Retain only
   sanitized evidence. Clean up the disposable environment afterward.

### Protected bootstrap bridge

Prepare this reviewed snippet as a temporary 0600 file outside the web root.
Run with an explicitly authorized WordPress user holding `manage_woocommerce`,
the site's normal OS identity, and the plugin loaded:
`WCTM_RECOVERY_FILE=/protected/recovery.json wp --user=<authorized-user-id> eval-file /protected/recover.php`.
The environment value is a **path**, not a secret. The JSON fields are
`storeId`, `apiOrigin`, `registrationToken`, `webhookSecret`, `webhookEndpointKey`; populate
from protected authenticated responses above. Do not enable CLI debug, shell
tracing, request-body logging or PHP error dumps containing input. This snippet
is a design artifact and has not been executed on a WordPress site.

```php
<?php
function recovery_stop(): void { throw new RuntimeException('Recovery stopped; inspect protected state'); }
if (!current_user_can('manage_woocommerce')) recovery_stop();
$path = getenv('WCTM_RECOVERY_FILE');
if (!is_string($path) || !is_file($path) || is_link($path) ||
    (fileperms($path) & 0777) !== 0600) recovery_stop();
$input = json_decode(file_get_contents($path), true);
if (!is_array($input) || !wc_telegram_connector_secret_key() ||
    !is_string($input['apiOrigin'] ?? null) ||
    $input['apiOrigin'] !== wc_telegram_connector_api_base_url() ||
    !is_string($input['storeId'] ?? null) || $input['storeId'] === '' ||
    strlen($input['storeId']) > 64 ||
    !is_string($input['registrationToken'] ?? null) ||
    preg_match('/\Areg_[A-Za-z0-9_-]{43}\z/D', $input['registrationToken'] ?? '') !== 1 ||
    !wc_telegram_connector_valid_material($input['webhookSecret'] ?? null) ||
    !wc_telegram_connector_valid_material($input['webhookEndpointKey'] ?? null, 'whk_')) recovery_stop();
// All old exact hooks must already be removed. Any canonical name now is a collision.
foreach (wc_telegram_connector_load_webhooks() as $hook) {
    $data = $hook->get_data();
    foreach (wc_telegram_connector_required_topics() as $topic) {
        if (($data['name'] ?? null) === wc_telegram_connector_webhook_name($topic)) recovery_stop();
    }
}
$result = wc_telegram_connector_register($input['registrationToken']);
$input['registrationToken'] = '';
if (!is_array($result) || ($result['storeId'] ?? null) !== $input['storeId'] ||
    !wc_telegram_connector_valid_material($result['pluginCredential'] ?? null, 'plg_')) recovery_stop();
// Existing M8 values are supplied independently; M7 must not replace them unexpectedly.
if (isset($result['webhookSecret']) || isset($result['webhookEndpointKey'])) recovery_stop();
if (!wc_telegram_connector_store_secret('plugin_credential', $result['pluginCredential']) ||
    !wc_telegram_connector_store_secret('webhook_secret', $input['webhookSecret']) ||
    !wc_telegram_connector_store_option('store_id', $input['storeId']) ||
    !wc_telegram_connector_store_option('webhook_endpoint_key', $input['webhookEndpointKey'])) recovery_stop();
if (!hash_equals($result['pluginCredential'], wc_telegram_connector_read_secret('plugin_credential')) ||
    !hash_equals($input['webhookSecret'], wc_telegram_connector_read_secret('webhook_secret')) ||
    wc_telegram_connector_read_option('store_id') !== $input['storeId'] ||
    wc_telegram_connector_read_option('webhook_endpoint_key') !== $input['webhookEndpointKey']) recovery_stop();
// Freeze webhook administration throughout: installer ownership currently matches name only.
if (!wc_telegram_connector_install_and_confirm_webhooks()) recovery_stop();
$result = $input = [];
echo "Recovery material and webhook health: PASS; ingestion checks still required\n";
```

A partial write, deleted-hook failure, lost registration response or failed health
check leaves the site in maintenance. Do not retry stale tokens or restore old
route/secret backups automatically. Inspect exact state, obtain fresh M8 rotation
and fresh M7 token, remove only the verified obsolete hooks, and restart the
procedure. Maintain exclusive registration/rotation and webhook-administration access; if
this cannot be enforced, stop. Dispose of superseded secret exchange files on
both success and failure; keep only protected recovery state explicitly needed
for the next authorized attempt. The operations span two systems and are not
atomic. Escalate scope
ambiguity or unavailable authorities to A.

Source grounding: `backend/src/store/store-registration.service.ts` (M8 rotation,
M7 credential replacement), `backend/src/store/store.controller.ts` (authorized
routes), and `wp-content/plugins/wc-telegram-connector.php` (encryption, complete
hook enumeration, registration, installation and health). Repository PHP fixtures
prove lost-salt failure and exact uninstall selection; they do not prove this
operator bridge or representative-site ingestion. See
[PPR2_NONPRODUCTION_ACCEPTANCE.md](PPR2_NONPRODUCTION_ACCEPTANCE.md).
