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
the database. `export` requires `--retain-for-delivery`; the wrapper generates
an exact Store-scoped `wctm-privacy-export-<scope-hash>-<millisecond-time>-<nonce>.json`
name inside the protected directory and the CLI creates it mode 0600. No
operator-supplied output path is accepted by the wrapper. The hash binds the
file to the exact Tenant/Store without putting merchant data in its name.

After a successful `erase --execute`, the wrapper removes only matching exports
for that Tenant/Store. After a merchant export has been securely delivered,
the operator runs this scoped cleanup to finish that request:

```sh
scripts/ops/privacy-export-artifacts.sh purge /var/lib/wctm/privacy TENANT_ID STORE_ID
```

Delivery
outside the protected directory must use an approved protected channel; the
file is not a long-term archive. Every operator entry also sweeps expired
exports. Install and enable the reviewed
`ops/systemd/wctm-privacy-export-retention.service` and `.timer` for the
canonical `/var/lib/wctm/privacy` directory, owned by the `wctm` service
account with mode 0700. The timer runs under that existing account and does not
require another account to receive Docker or ledger access; its unit hides the
Docker socket and production `.env`. Cleanup uses the host's existing Bash,
coreutils and OpenSSL tools; it needs no host Node, Docker access or network.
Install the two
unit files from `ops/systemd/`, reload systemd, enable the timer and verify the
first one-shot sweep succeeds before using real merchant exports. The hourly
timer deletes exact export artifacts at
23 hours, using the earliest valid name/filesystem creation evidence, so an
operating timer bounds abandoned files to at most 24 hours;
check timer/service failures during pilot operations. The sweep refuses
symlinks and non-0600 matching files and never selects the erasure ledger,
keys, backups or arbitrary operator files. Removal unlinks the file; storage
snapshots and filesystem remnants remain subject to their own retention and
access controls.

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

| Data                                                        | Repository rule                                             | Boundary                                                                                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| BullMQ completed jobs                                       | 24 hours; terminal cleanup hourly, up to 1000 per sweep     | Active/waiting/delayed work is never selected. Heavy backlog may take additional sweeps.                                                            |
| BullMQ failed jobs                                          | 7 days; same terminal sweep                                 | Diagnostic result/IDs persist until then.                                                                                                           |
| Redis rate-limit and dedupe state                           | Existing 60-second rate windows; job keys as above          | Redis AOF is persistent and old bytes may remain until compaction; physical data expiry needs live proof.                                           |
| Link/registration tokens and encrypted callback/search text | Clear 1 day after their expiry; daily PostgreSQL oneshot    | Existing active TTLs remain unchanged; backend runtime cannot DELETE.                                                                               |
| Completed webhook payload                                   | Clear 30 days after completion; daily PostgreSQL oneshot    | Event metadata/dedupe stays for operational integrity.                                                                                              |
| Failed webhook payload                                      | Clear 90 days after failure; daily PostgreSQL oneshot       | Pending/active events are untouched.                                                                                                                |
| Security audit rows                                         | 365 days; daily PostgreSQL oneshot                          | Backend audit writes remain append-only; only the separate retention identity may expire old rows. Minimal erasure ledger stays separate.           |
| Protected Store privacy exports                             | Remove after erasure or confirmed delivery; 24-hour maximum | Exact scoped names only; hourly sweep begins at 23 hours, with a sweep on every operator entry. Timer installation/live proof remains a pilot gate. |
| Local PostgreSQL backups                                    | Existing 14 validated sets                                  | Newer 14 sets always protected; this is count-based, not a calendar age.                                                                            |
| New encrypted OneDrive sets                                 | 30 days, always keep newest 2 complete sets                 | Legacy plaintext and incomplete sets are never auto-deleted.                                                                                        |
| Application and scheduler logs                              | No repository-enforced calendar limit yet                   | Host Docker/journald policy and live proof are a pilot gate.                                                                                        |

### Production-discovered PostgreSQL privilege correction

The live PPR-2 backend sweep failed at `telegram_link_tokens` because
`wctm_runtime` correctly lacks DELETE; search-reference UPDATE and audit-row
DELETE also conflict with its approved boundary. The backend no longer schedules
or executes PostgreSQL retention. The fixed SQL allowlist in
`scripts/ops/postgres-retention.sql` runs daily as a dedicated `wctm_retention`
login through `wctm-postgres-retention.service`/`.timer`. Its role has only
column-specific SELECT/UPDATE on the six listed tables plus table DELETE on
link tokens and audit rows; the fixed SQL applies the age cutoffs. It has no
INSERT, migration-table DML, table
ownership, schema CREATE, database CREATE/TEMP, role inheritance, or elevated
flags. The normal runtime role gains no grants and remains unable to alter
audit rows. Each of the seven mutations is capped at 20 batches of 500 rows
per run, with a transaction advisory lock, five-second lock timeout and
ten-minute statement timeout. Repeated runs are safe; backlogs drain on later
runs. A failed statement rolls the transaction back and fails the oneshot.

This is a cluster role, not a Prisma migration or a database-dump object. On a
fresh cluster, recreate it separately before enabling the timer. An authorized
operator creates the login interactively with `psql` and `\password`, then
applies `scripts/ops/postgres-retention-grants.sql` as the database owner and
runs `scripts/ops/verify-retention-role.sql`. The normal backend receives no
retention credential. Store its single-entry PostgreSQL password file at the
externally configured `WCTM_RETENTION_PGPASS_FILE`, owned by `wctm`, mode 0600
or 0400. Its format is exactly
`127.0.0.1:5432:<database>:wctm_retention:<password>` (escape `:` or `\` in
the password using libpq `.pgpass` rules). The non-secret environment example
is `ops/systemd/postgres-retention.conf.example`; it must name the exact
Compose project and database. The oneshot selects exactly that project's
PostgreSQL container, verifies its reviewed immutable image, and launches the
same local image by ID as a short-lived, read-only, unprivileged `psql` client
in the PostgreSQL container's network namespace. It mounts only the protected
password file, sends the fixed SQL on stdin, does not parse `/srv/wctm/.env`,
and needs neither host Node nor external network access. Docker access by the
`wctm` service account remains a powerful host capability and must stay
limited to that dedicated account. The SQL credential is a separate,
column-limited identity, never the owner/migration or backend runtime secret.

After repository deployment, the authorized production operator may validate
without displaying credentials:

```sh
cd /srv/wctm
pg_container=$(docker compose ps -q postgres)
docker exec -it "$pg_container" sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
# In that interactive psql session: CREATE ROLE wctm_retention LOGIN NOINHERIT;
# Then: \password wctm_retention; exit with \q.
docker exec -i "$pg_container" sh -c 'exec psql -X -v ON_ERROR_STOP=1 -v "DBNAME=$POSTGRES_DB" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <scripts/ops/postgres-retention-grants.sql
docker exec -i "$pg_container" sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <scripts/ops/verify-retention-role.sql
sudo install -d -m 0750 -o root -g wctm /etc/wctm
sudo install -m 0640 -o root -g wctm ops/systemd/postgres-retention.conf.example /etc/wctm/postgres-retention.conf
sudoedit /etc/wctm/postgres-retention.conf  # replace both placeholders
# First installation only: refuse to overwrite an existing credential.
sudo test ! -e /etc/wctm/postgres-retention.pgpass
sudo install -m 0600 -o wctm -g wctm /dev/null /etc/wctm/postgres-retention.pgpass
sudoedit /etc/wctm/postgres-retention.pgpass  # enter one local .pgpass line; do not print it
sudo install -m 0644 ops/systemd/wctm-postgres-retention.service ops/systemd/wctm-postgres-retention.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start wctm-postgres-retention.service
sudo systemctl status wctm-postgres-retention.service --no-pager
sudo journalctl -u wctm-postgres-retention.service -n 30 --no-pager
scripts/ops/verify-runtime-role.sh
sudo systemctl enable --now wctm-postgres-retention.timer
sudo systemctl list-timers wctm-postgres-retention.timer --no-pager
```

Run the grants/verification as the owner after role recreation on restored
clusters, but retain the protected runtime role and separate migration identity.
Do not enable the timer until the role verification and first oneshot PASS. The
script emits only a start/PASS or non-secret failure message. Live execution,
role proof, and absence of backend permission errors remain PPR-2 production
validation gates; real-merchant onboarding stays blocked.

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
by the dedicated backup account outside Git and OneDrive. Encryption, metadata
selection and restore use the dedicated `privacy-ops` target in
`backend/Dockerfile`. Build it locally before backup or privacy operations:
`docker build --pull=false --target privacy-ops -t wctm-privacy-ops:node24.20.0-alpine3.24-openssl3.5.9-r0 -f backend/Dockerfile .`.
It inherits the immutable reviewed Node 24.20.0 / Alpine 3.24 base and the
SHA-256-verified OpenSSL 3.5.9-r0 package installation, then removes global npm,
Corepack, Yarn and APK tooling. The runner resolves the reviewed local tag to an immutable
image ID and uses it with `--pull=never`, no network, a read-only root and only
explicit input/key/output mounts. Docker access, that locally built ops image
and the readable key file require live validation; no host Node installation is
needed. The decrypted dump is only created in
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
6. Install and verify the protected privacy-export retention timer on the
   operator host before processing real merchant exports. Review its service
   status and confirm the privacy directory ownership and mode.

Until these gates are closed and accepted, PPR-2 remains active and real-merchant
pilot onboarding remains blocked. No public-launch readiness is claimed.
