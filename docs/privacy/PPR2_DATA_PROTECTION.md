# PPR-2 pilot data protection controls

Status: implementation branch, **not production validated**. PPR-1 is complete on
`main`. This document describes the repository behavior and the remaining gates
for a controlled real-merchant pilot. Phase 7 remains paused.

## Data minimization

After HMAC verification, order and product webhook bodies are projected through
`minimizeWebhookPayload` before PostgreSQL persistence. The order event retains
order ID/number/status, currency and totals, payment method label, relevant
timestamps, billing name/company, shipping address fields used by Telegram,
line-item name/quantity/total, and shipping method labels. Product events retain
identity, parent/type, stock state/quantity, SKU/name, modification time and
variation attributes needed for inventory. Unknown metadata, order notes,
phone/email, billing address, Woo customer ID and arbitrary line-item fields are
discarded. Deleted events need only identity. The order projection applies the
same customer and line-item limits. Telegram can still receive customer name and
shipping address when an authorized manager requests order detail; Telegram's
own retention is outside WCTM's control.

Historical rows are **not changed automatically**. The operator must quiesce the
application, back up, dry-run and execute `pilot-privacy.sh scrub` for each
verified Tenant/Store. It processes terminal webhook events and existing order
snapshots in bounded batches, checks scoped identities before each write, and
recomputes order fingerprints. Pending/processing events are left untouched for
normal completion; a later scrub pass is required. Older backups retain the
original data until expiry and require erasure-ledger replay after restore.

## Verified operator lifecycle

`scripts/ops/pilot-privacy.sh` is an operator-only, non-HTTP entry point. It
requires an exact Tenant ID, Store ID and HTTPS base URL, a protected database
owner credential file, the application encryption key already in protected
Compose configuration, and a 0700 external privacy directory with a 0600
erasure ledger. The credential file contains exactly one `DATABASE_URL=` entry,
is 0600/0400, and is never committed. The backend runtime DB role is rejected.
Execution of disconnect/scrub/erase/replay refuses to run while backend or bot
containers are running. This is an intentional maintenance window, not an API
that merchant input can invoke. Inspect/export are read-only with respect to
the database; export creates a new mode-0600 file in the protected directory.

Disconnect first revokes the connector token, registration token, webhook route
and secret, replaces the encrypted Woo REST key/secret with unusable random
values, marks the Store disconnected/deleted, revokes its active Telegram chat
context, and fails queued/processing Store webhook events. The operator command
then tries to remove only exact WCTM-owned WooCommerce webhook records using the
pre-revocation credentials held in memory. If Woo removal fails, the report says
`manual-required`; the local route and credentials remain revoked. The operator
must reconcile the Woo side before closing the request. Plugin deactivation,
uninstall, normal Store soft delete and Telegram unlink are **not** this workflow.

Erasure requires a prior verified disconnect. An exact Store-scoped request is
recorded in an external append-only 0600 ledger containing only Tenant/Store IDs,
SHA-256 of the original base URL and time. The ledger is encrypted and remotely
verified **before** live erasure. Erasure clears that Store's webhook payloads,
order customer/line/payment/shipping snapshots and totals, inventory labels/SKU,
encrypted callback/search text and action results. Store name/base URL become a
tombstone. Referential IDs, delivery state and narrow audit events remain for
integrity/security evidence. The operator must inspect the export and confirm
scope/authority before `--execute`. This is **Store-scoped** erasure; it does not
delete shared Tenant/User/Telegram identities or Telegram messages. Whole-account
requests require a separately reviewed procedure.

Before a restored old backup becomes authoritative, recover the latest external
erasure ledger, verify/decrypt it, keep backend and bot stopped, and execute
`replay`. Replay checks each Tenant/Store and base-URL hash, disconnects and
erases matching restored records, skips already erased stores, and fails closed
on mismatches. Only after replay and normal role/config/readiness checks may
application service resume. Keep the ledger and its encryption key for as long
as any recoverable backup could predate an erasure. Historic backups expire by
retention; they are not rewritten in place.

## Explicit pilot retention decisions

| Data                                                        | Repository rule                                         | Boundary                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| BullMQ completed jobs                                       | 24 hours; terminal cleanup hourly, up to 1000 per sweep | Active/waiting/delayed work is never selected. Heavy backlog may take additional sweeps.                  |
| BullMQ failed jobs                                          | 7 days; same terminal sweep                             | Diagnostic result/IDs persist until then.                                                                 |
| Redis rate-limit and dedupe state                           | Existing 60-second rate windows; job keys as above      | Redis AOF is persistent and old bytes may remain until compaction; physical data expiry needs live proof. |
| Link/registration tokens and encrypted callback/search text | Clear 1 day after their expiry; daily sweep             | Existing active TTLs remain unchanged.                                                                    |
| Completed webhook payload                                   | Clear 30 days after completion; daily sweep             | Event metadata/dedupe stays for operational integrity.                                                    |
| Failed webhook payload                                      | Clear 90 days after failure; daily sweep                | Pending/active events are untouched.                                                                      |
| Security audit rows                                         | 365 days; daily sweep                                   | Minimal erasure ledger is held separately for restore safety.                                             |
| Local PostgreSQL backups                                    | Existing 14 validated sets                              | Newer 14 sets always protected; this is count-based, not a calendar age.                                  |
| New encrypted OneDrive sets                                 | 30 days, always keep newest 2 complete sets             | Legacy plaintext and incomplete sets are never auto-deleted.                                              |
| Application and scheduler logs                              | No repository-enforced calendar limit yet               | Host Docker/journald policy and live proof are a pilot gate.                                              |

## WordPress and backup confidentiality

The WCTM-owned connector credential and WCTM webhook secret in WordPress options
use AES-256-GCM with separate associated-data labels. The key derives by HKDF
from WordPress `AUTH_KEY` and `SECURE_AUTH_KEY`, which should live outside the
WordPress database. Exact legacy plaintext token shapes migrate on first read.
Missing salts or authentication failure yields no credential and no plaintext
fallback. Reconnect/rotation must reprovision secrets with the service operator
if host salts are lost. WordPress administrators, host files and backups remain
within the merchant's trust boundary. WooCommerce itself persists its webhook
signing secret in its own database; this plugin does not alter Woo internals.

The scheduled off-site path encrypts the locally created custom-format dump
using a separately stored 32-byte mode-0600 key before rclone upload. OneDrive
receives only `.dump.enc`, `.dump.enc.json` and `.dump.enc.sha256` for new sets.
AES-256-GCM authenticates ciphertext; local SHA-256 verifies the original dump,
and remote content SHA-256 verifies uploaded ciphertext. The key must be owned
by the dedicated backup account outside Git and OneDrive. The scheduled service
requires a host Node runtime and a readable key file; these are new deployment
prerequisites requiring live validation. The decrypted dump is only created in
an operator-controlled 0700 directory, then used with the existing isolated
restore procedure. Encryption does not replace checksum or restore tests.

Retain the current key until every backup encrypted under it has expired and
every archived erasure ledger encrypted under it has been re-encrypted and
verified with the replacement key. Rotation is a reviewed maintenance action:
create a new private key, retain the old key in separate protected recovery
storage, update the key path, make a new encrypted backup, decrypt/restore it in
isolation, and verify ledger recovery before retiring the old key. Losing the
key loses the off-site recovery path. Existing plaintext OneDrive sets are
**not** silently deleted or converted; inventory them and obtain a reviewed
retention/deletion decision. Treat them as sensitive until removed.

## Remaining gates before real merchants

1. Review and execute the lifecycle, scrub and encrypted backup/restore paths
   against isolated production-like data, including cross-tenant checks and
   erasure replay, then validate the scheduled encrypted path on `waltpack` in
   a separately authorized production operation.
2. Inventory and decide disposal of pre-PPR-2 plaintext OneDrive sets. No
   automatic legacy deletion is authorized by this branch.
3. Set and verify host Docker/journald log rotation/retention and Redis AOF
   compaction/physical expiry. The repository controls logical TTLs, not those
   host storage lifetimes.
4. Define a reviewed whole-Tenant/User/Telegram-account export and deletion
   process, including shared identities and security audit exceptions, before
   promising complete account erasure.
5. Verify WordPress salt-loss reconnect/rotation and Woo-owned signing-secret
   cleanup on a representative pilot merchant site.

Until these gates are closed and accepted, PPR-2 remains active and real-merchant
pilot onboarding remains blocked. No public-launch readiness is claimed.
