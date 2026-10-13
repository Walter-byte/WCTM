# Representative-site connector privacy validation

Run this on an authorized disposable WordPress/WooCommerce site with synthetic
data. Do not use a merchant site or production credentials. Record outcomes and
webhook IDs without copying credential values into tickets or logs.

1. Back up the disposable site and record its WordPress/WooCommerce/plugin
   versions. Use an isolated WCTM test Store and test-only M7 registration token.
2. Connect the plugin. Confirm the WCTM-owned connector credential and webhook
   secret are encrypted values in `wp_options`, autoload is disabled, and no
   secret appears in the admin page or logs. Confirm the required WCTM hooks
   have the exact expected name, topic, delivery URL and signing secret.
3. Add an unrelated WooCommerce webhook, including one with a similar name or
   route on another origin. Confirm retry/setup does not alter it.
4. In the disposable site only, replace the two WordPress host-side key
   constants used by the connector. Confirm saved WCTM secrets cannot decrypt,
   retry fails closed, and neither plaintext fallback nor secret output occurs.
5. Restore the original keys. Confirm connection health returns without
   credential regeneration. Repeat the lost-key state and verify that a fresh
   M7 token alone does **not** make the unreadable stored signing secret
   available. Record a fail-closed result. A separately reviewed operator
   rotation/reconnect procedure is required if the original salts cannot be
   restored; do not reuse an unreadable old secret or claim this path passes.
6. Exercise plugin uninstall on the disposable site while the old secret is
   unreadable. Confirm only hooks matching the exact configured WCTM delivery
   URL, topic and name are removed, unrelated hooks remain, and WCTM options
   are deleted. Deactivation alone must retain configuration and hooks.
7. Confirm no unexpected external requests, secret-bearing logs or customer
   data were produced. Restore/delete the disposable site according to its
   test-data policy.

Repository fixtures cover the salt-loss failure and exact uninstall selection.
The no-salts recovery procedure and this representative-site check remain
pilot blockers; neither has been run by this branch.
