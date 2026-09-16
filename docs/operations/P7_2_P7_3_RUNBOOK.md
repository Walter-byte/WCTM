# P7.2/P7.3 Production Operations Runbook

Status: repository implementation ready for review and A-owned production
validation. Nothing in this document marks P7.2 or P7.3 production-complete.

## Safety and identity boundary

- Normal backend runtime uses only `wctm_runtime`. It must remain non-owner,
  non-superuser, `NOINHERIT`, without database `TEMP`, schema `CREATE`, object
  ownership, or `_prisma_migrations` access.
- A distinct existing owner/migration identity is supplied only through a
  protected `DATABASE_URL` file for an explicit migration operation. No
  migration username or password is committed. The ephemeral migration
  container is removed after execution and the credential file remains outside
  the repository and normal backend environment.
- Backend startup runs only `node dist/main.js`; it never invokes Prisma
  Migrate or `db push`. Prisma Migrate and the checked-out
  `backend/prisma/migrations` directory remain authoritative.
- Never use `wctm_runtime` for migration. Never add migration credentials to
  `.env`, the backend service, a unit file, an image, or shell history. Never
  run `docker compose down -v` or delete production volumes.
- Commands below are production commands only when explicitly labelled. All
  destructive recovery actions require A's separate decision. Stop on every
  non-zero result unless a failure section explicitly says otherwise.

## Operator files

Create the migration credential file outside the checkout in a trusted shell
with tracing disabled and mode `0600` or `0400`. It contains one line only:

```text
DATABASE_URL=postgresql://MIGRATION_IDENTITY:REDACTED@postgres:5432/DATABASE
```

The scripts never print this value. URL-encode password characters as required.
The entrypoint rejects a missing identity and the exact `wctm_runtime` user.
After the operation, remove the file from the deployment workspace or return it
to protected secret storage; it must not remain available to backend runtime.

Backup sets contain:

- `wctm-postgres-<UTC>-<revision>.dump` — PostgreSQL custom-format dump;
- `.dump.sha256` — SHA-256 checksum;
- `.dump.json` — non-secret timestamp, database name, repository revision,
  completed migration count, size, checksum, and PostgreSQL tool/server version.

Directories are mode `0700`; files are mode `0600`; partial files are removed
on failure and final names appear only after dump readability succeeds.

## Supported repository commands

Repository-side checks:

```bash
docker compose config --quiet
bash -n scripts/ops/*.sh
```

Production backup (non-destructive):

```bash
scripts/ops/backup-postgres.sh --destination /var/backups/wctm
```

Backup with provider-neutral off-host transfer through the supplied rclone
hook (non-destructive; rclone credentials/configuration remain outside Git):

```bash
scripts/ops/backup-postgres.sh \
  --destination /var/backups/wctm \
  --offsite-hook scripts/ops/offsite-rclone.sh \
  --offsite-destination remote-name:wctm-production
```

The hook size-checks all three remote artifacts and requires the remote dump to
match the locally generated SHA-256 before success. It uses a compatible native
remote SHA-256 when rclone exposes one; otherwise it streams the remote dump
through rclone and hashes that stream locally without overwriting the local
backup. Copy, metadata, size, SHA-256, or integrity-verification failure returns
non-zero. A local backup remains valid when remote transfer fails, but the DR
gate fails. The production destination is an A-owned live-validation choice.

Explicit migration (schema-changing, fail-fast):

```bash
scripts/ops/migrate-production.sh \
  --credential-file /run/wctm/migration.env
```

Deterministic application deployment (migration and service recreation can
change production state):

```bash
scripts/ops/deploy-production.sh \
  --revision FULL_REVIEWED_GIT_SHA \
  --migration-credential-file /run/wctm/migration.env \
  --backup-directory /var/backups/wctm
```

The deployment script requires the exact revision, a clean worktree, inclusion
in synchronized `origin/main`, valid Compose configuration, running services,
an all-PASS production configuration audit, and a fresh verified backup. It
builds the migration/backend/bot images, runs migration before cutover, stops
immediately on migration failure, recreates backend then bot, checks local
health/readiness, and verifies the actual backend identity and restrictions.
It does not reconcile PostgreSQL/Redis images or run product smoke by itself;
those controlled gates below surround the application deployment.

## Controlled PostgreSQL/Redis image reconciliation

The repository requires these exact references:

```text
postgres:16.15-alpine3.24@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685
redis:7.4.11-alpine3.21@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf
```

Before reconciliation, inspect and record the running named volumes:

```bash
docker inspect "$(docker compose ps -q postgres)" \
  --format '{{range .Mounts}}{{.Type}} {{.Name}} {{.Destination}}{{println}}{{end}}'
docker inspect "$(docker compose ps -q redis)" \
  --format '{{range .Mounts}}{{.Type}} {{.Name}} {{.Destination}}{{println}}{{end}}'
```

Abort if either expected data path is not a named volume, is empty, differs
from the recorded production volume, or the fresh backup set is incomplete.
Run the guarded procedure with the exact inspected names:

```bash
scripts/ops/reconcile-data-images.sh \
  --backup /var/backups/wctm/wctm-postgres-UTC-REVISION.dump \
  --postgres-volume EXACT_POSTGRES_VOLUME \
  --redis-volume EXACT_REDIS_VOLUME
```

This verifies the backup checksum, volumes, completed migration count, and
Redis key count; stops backend and bot; pulls and recreates only PostgreSQL and
Redis; preserves both named volumes; verifies PostgreSQL and Redis health,
unchanged volume attachments/data indicators, and exact image references; and
leaves application services stopped for the deployment gate. It never removes
a volume. After success, run the supported deployment command.

On failure, do not delete or initialize either volume. Keep applications
stopped, inspect `docker compose logs postgres redis`, confirm the same volumes
are attached, and recreate the affected service with the last known-good
same-major image if safe. If database state is damaged or cannot start, use the
restore/recovery procedure; do not improvise a new production database.

## Backup retention and schedule

Retention is explicit and count-based. Default operational policy is 14 valid
daily sets (approximately 14 days). Dry-run first:

```bash
scripts/ops/backup-retention.sh --directory /var/backups/wctm --keep 14
scripts/ops/backup-retention.sh --directory /var/backups/wctm --keep 14 --apply
```

Only complete, checksum-valid files matching WCTM's exact timestamped naming
pattern are candidates. Unrelated files, incomplete/corrupt sets, and at least
the newest valid backup are never deleted. Nothing schedules deletion unless
the operator explicitly installs the scheduled wrapper or runs `--apply`.

The repository templates provide a daily Ubuntu systemd timer. Review paths,
service account, Docker access, and off-host destination before installation:

```bash
sudo install -d -o root -g wctm -m 0750 /etc/wctm
sudo install -o root -g wctm -m 0640 \
  ops/systemd/backup.conf.example /etc/wctm/backup.conf
sudo install -o root -g root -m 0644 \
  ops/systemd/wctm-backup.service /etc/systemd/system/wctm-backup.service
sudo install -o root -g root -m 0644 \
  ops/systemd/wctm-backup.timer /etc/systemd/system/wctm-backup.timer
sudo systemctl daemon-reload
sudo systemctl start wctm-backup.service
sudo systemctl status wctm-backup.service
sudo systemctl enable --now wctm-backup.timer
systemctl list-timers wctm-backup.timer
journalctl -u wctm-backup.service
```

These are instructions for A; C does not install or enable them. The unit
contains no secret. `/etc/wctm/backup.conf` holds paths and the optional remote
name; provider credentials use the operator's protected rclone configuration.
The service's non-zero exit and journal entry make backup/copy/retention
failures observable. Confirm the `wctm` account can access Docker without
broadening unrelated host privileges before enabling the timer.

## Isolated restore test

The supported restore command has no production database URL or remote target
option. It always creates a uniquely named PostgreSQL 16.15 container and
volume with `--network none`, publishes no port, verifies checksum and dump
readability, restores with `--no-owner --no-privileges`, compares completed
migrations to the checked-out repository, checks public tables, and reports
configured critical table row counts. It removes only its generated isolated
container/volume. The optional diagnostic retention flag never targets an
existing resource.

```bash
scripts/ops/restore-isolated.sh \
  --backup /var/backups/wctm/wctm-postgres-UTC-REVISION.dump \
  --critical-table tenants \
  --critical-table users \
  --critical-table memberships \
  --critical-table stores \
  --critical-table orders \
  --critical-table audit_logs
```

Compare the reported counts to a source-side, non-secret count record captured
at backup time when recovery validation requires exact continuity. Application-
compatible validation may use a separately started test backend attached only
to this isolated database with synthetic credentials and no external Telegram
or WooCommerce calls. It is optional and must never reuse production service
secrets or expose the restore target.

For diagnosis only, `--keep-on-failure` retains the uniquely generated isolated
resources and prints their names. Remove only those exact names after review.

## Recovery dependencies

A database dump alone cannot recover encrypted Store credentials, webhook
secrets, pending Telegram note text, or saved search text. Recovery requires:

- the valid `APP_ENCRYPTION_KEY` corresponding to the backup;
- only during a historically applicable controlled rotation window, the
  required decrypt-only previous APP key;
- the database backup, checksum, and metadata;
- the matching repository/application revision and migration history;
- securely restored JWT, backend-bot, callback-signing, bot, runtime database,
  and connector-related secrets needed for their own authentication functions.

JWT, callback-signing, bot/internal API, and database credentials do not decrypt
stored application ciphertext. They restore session/signing/service/database
trust boundaries. Never print, encode into docs, or commit any recovery secret.

## Disaster-recovery sequences

### Application/container loss with VPS and volumes intact

1. Preserve and inspect named volumes; do not initialize or delete them.
2. Check out the exact reviewed revision and restore protected runtime config.
3. Validate Compose, exact images, disk, PostgreSQL/Redis health, and backup.
4. Run explicit migrations only if the repository revision requires them.
5. Recreate backend and bot, then pass config audit, runtime-role verification,
   health/readiness, and bounded smoke.

### Failed or corrupted deployment

1. Stop cutover on build/migration/readiness failure and preserve logs.
2. Before migration, continue running the old application; no DB rollback is
   required. After migration, an old image may be incompatible with the new
   schema, so do not blindly redeploy it.
3. If the migration is additive and verified compatible, A may restore the
   prior reviewed application image. Otherwise select database recovery below.
4. Prisma migrations are not universally reversible. Never synthesize a down
   migration during an incident.

### Database loss or corruption

1. Stop backend and bot to prevent writes. Preserve failed database data and
   logs for diagnosis.
2. Select the newest verified backup compatible with the protected APP key and
   repository revision; first pass the isolated restore procedure.
3. A must explicitly authorize creation/replacement of the production target.
   The repository provides no production-overwrite command by default.
4. Restore custom dump, validate migrations/schema/critical counts, restore the
   restricted runtime grants, and verify `wctm_runtime` before starting apps.
5. Deploy the matching application revision, then run full recovery smoke.

### Complete VPS loss

1. Provision supported Ubuntu/Docker/Compose/Caddy capacity with private
   PostgreSQL/Redis/bot networking, loopback backend publication, TLS, firewall,
   time synchronization, disk capacity, and a non-root operator account.
2. Check out the reviewed revision. Restore protected configuration and keys
   from secret storage, never from the database backup.
3. Initialize exact immutable PostgreSQL/Redis images and new named volumes.
4. Restore the verified off-host database backup, validate schema/migrations and
   critical counts, then recreate the restricted runtime role/grants.
5. Run explicit migrations only if intentionally advancing beyond the restored
   revision. Deploy backend and Telegram bot and restore Caddy routing.
6. Validate Store/connector state. Existing WooCommerce hooks and Store secrets
   normally survive through the database; reconcile only through existing M7/M8
   paths if evidence shows otherwise. Restore the Telegram bot token and shared
   backend-bot key coherently; links persist in the restored database.
7. Pass config audit, role verification, health/readiness, bounded product
   smoke, permission/error/secret scans, and a new post-recovery backup.

Redis queue/transient state may not represent every in-flight effect after a
disaster. Preserve existing at-least-once/idempotency rules and inspect durable
database delivery/event state before replaying anything. Do not blindly resend
Telegram or WooCommerce effects.

## Initial recovery objectives

These are operational targets, not contractual guarantees or an SLA:

- RPO target: at most 24 hours with the daily verified off-host backup; reduce
  the timer interval only after capacity and restore testing support it.
- RTO target: eight hours for a single-host recovery with infrastructure,
  secrets, reviewed images, and a verified backup available.
- Retention target: 14 valid daily local sets plus an independently retained
  off-host copy policy chosen by A/provider. Same-VPS copies alone do not meet
  the DR target.

## A-owned combined production validation session

Every gate is fail-fast. A may record a single final evidence bundle instead of
reporting after each successful command. Stop immediately for a failed backup,
off-host copy, migration, identity check, data continuity check, health or
readiness check, secret exposure, or unexplained permission/migration error.

### Gate 1 — preflight

1. Synchronize `main`, verify the reviewed full SHA, clean worktree, and its
   containment in `origin/main`; run `docker compose config --quiet`.
2. Record `docker compose ps`, current exact image strings, disk/inode capacity,
   PostgreSQL/Redis named volumes, and current completed migration count.
3. Pass current health/readiness and `security:config-audit`.
4. Pass `scripts/ops/verify-runtime-role.sh`; runtime must be `wctm_runtime`.

### Gate 2 — fresh backup

1. Run `backup-postgres.sh` to the protected backup directory.
2. Confirm non-empty dump, `.sha256`, `.json`, mode, checksum, migration count,
   and `pg_restore --list` success as reported by the command.
3. Run the off-site hook and require its verified PASS. Stop if remote transfer
   fails; do not call the gate successful because the local copy exists.

### Gate 3 — migration path

1. Place the distinct owner/migration URL in the protected one-line file.
2. Run `migrate-production.sh`; require Prisma Migrate success/current status.
3. Confirm the ephemeral migration container is absent afterward and remove or
   secure the credential file outside normal runtime.
4. Re-run runtime-role verification; backend remains `wctm_runtime` with no
   migration-table access. A failed migration stops before application cutover.

### Gate 4 — immutable PostgreSQL/Redis reconciliation

1. Reconfirm Gate 2 backup and exact volume names.
2. Run `reconcile-data-images.sh` with those explicit values.
3. Require exact reviewed image references, same named volumes, unchanged
   migration count and Redis key count, PostgreSQL readiness, and Redis PONG.
4. Applications intentionally remain stopped. On any failure, preserve volumes
   and enter the documented abort/recovery path.

### Gate 5 — application deployment

1. Run `deploy-production.sh` at the reviewed SHA. Its second fresh backup and
   repeat migration are intentional and must be safe/idempotent.
2. Require clean backend/bot startup, all-PASS config audit, local health and
   readiness, restricted-role PASS, current APP key only, and no migration
   credential in backend runtime.

### Gate 6 — bounded functional smoke

Validate only: web login; authenticated Tenant read; Telegram `/status`;
`/orders` plus detail; `/search`; `/report`; `/stock`; and Store/connector
health. A new synthetic customer/order mutation is not required unless another
gate provides insufficient evidence.

### Gate 7 — post-deployment backup

Create a fresh local custom-format backup and verified off-host copy from the
new state. Record filename, UTC timestamp, revision, size, migration count, and
checksum only.

### Gate 8 — isolated restore

Run `restore-isolated.sh` against the Gate 7 backup with the critical tables
listed above. Require checksum/readability, isolated no-network PostgreSQL,
restore success, exact repository migration count, expected schema/tables,
credible critical row counts, and clean generated-resource teardown.

### Gate 9 — final scans

Pass final health/readiness, config audit, runtime-role check, and bounded recent
logs for database permission, migration, backup/restore, startup, and secret-
pattern failures. Do not paste matching secret-bearing output. Record that no
production volume was removed and that P7.2/P7.3 acceptance remains A-owned.

## Failure matrix

| Failure                      | Required response                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Image build/pull             | No migration/cutover if build fails; keep current services. A failed data-image pull stops before recreation.                           |
| Migration before cutover     | Stop. Keep current app if still compatible/running. Remove ephemeral migration container. Diagnose with secret-safe logs.               |
| Backend startup/readiness    | Keep bot stopped or restore coherent backend/bot application images only when schema-compatible. Do not roll back schema automatically. |
| PostgreSQL/Redis recreation  | Keep apps stopped, preserve named volumes, inspect logs/mounts, retry known-good same-major image or enter restore.                     |
| Migration/data damage        | Stop all writers and use the verified P7.3 recovery process. Prisma rollback is not assumed.                                            |
| Backup/off-host/restore test | Deployment/acceptance stops; preserve the last valid backup and diagnose. Never report partial success as DR readiness.                 |
