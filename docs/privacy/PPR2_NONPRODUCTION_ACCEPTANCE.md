# PPR-2 non-production acceptance evidence

Validation date: 2026-10-15 (Asia/Tehran). Baseline:
`ab7d0ef0b7947904ace0e242133e048213492944`. PPR-2 remains **Active**,
real-merchant onboarding **Blocked**, and Phase 7 **Paused**. These are synthetic
engineering results submitted for independent review, not pilot/release acceptance.

## Reproduce the focused checks

Use exact Node **24.20.0** on PATH. This session used the official Darwin arm64
archive in `/private/tmp/wctm-ppr2-node24-acceptance`, verified against the official
`SHASUMS256.txt`; no host runtime or project dependencies were changed. Docker
Desktop must be available with `host.docker.internal` access to its loopback
published PostgreSQL port. Prebuild/cache the reviewed `wctm-backend:latest`,
`wctm-telegram-bot:latest`, and
`wctm-privacy-ops:node24.20.0-alpine3.24-openssl3.5.9-r0` images. The account
fixture resolves the backend tag to its immutable local image ID, checks its
Node version, and mounts the newly built repository `backend/dist` read-only.
The pinned PostgreSQL image is reused with `--pull=never`; no site is contacted.
Missing tools/images are environment prerequisites, not an application result.

```sh
npm run build --workspace backend
scripts/ops/test-pilot-account-integration.sh
scripts/ops/test-pilot-privacy.sh
scripts/ops/test-backup-crypto.sh
node scripts/ops/test-privacy-export-artifacts.mjs
node --test backend/test/wordpress-plugin.test.cjs
# Run Jest from backend/, so ts-jest resolves its existing configuration:
cd backend
../node_modules/.bin/jest --runInBand src/privacy/pilot-account.service.spec.ts src/privacy/pilot-data.cli.spec.ts src/privacy/pilot-data.service.spec.ts src/privacy/woo-webhook-cleanup.spec.ts src/store/store-registration.service.spec.ts
```

Native PHP check from repository root (existing cached PHP 8.4 image):

```sh
docker run --rm --pull=never --entrypoint php -v "$PWD:/work:ro" -w /work php:8.4-cli-alpine backend/test/fixtures/wordpress-plugin-reconciliation.php
bash -n scripts/ops/test-pilot-account-integration.sh
git diff --check
```

## Observed results and limits

| Check                          | Result and evidence boundary                                                                                                                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend build                  | PASS on Node 24.20.0; Prisma client generated from unchanged schema.                                                                                                                                                                                                                    |
| Account integration            | PASS on disposable PostgreSQL 16.15, all 16 migrations; exact Tenant/User/Store selection, scoped exports, exclusive Telegram anonymization, shared identity/other Tenant chat preservation, soft-deleted/removed memberships, audit evidence/FK continuity, restore and repeat replay. |
| Missing/partial evidence       | PASS: retained scoped PII, expired/missing audit proof, pre-membership restore, absent Tenant fail closed; absent User safely skipped only under existing semantics.                                                                                                                    |
| Actual privacy wrapper         | PASS using actual Compose/CLI/database and reviewed crypto image: protected 0600 identity export, Tenant/Store/User erasure, old plugin/token/route/secret fields revoked, wrong-Tenant Store export rejected, another Tenant's same-URL Store unchanged.                               |
| Archive failure                | PASS: injected transport-copy failure after preparation preserves User PII and delivery export; prepared ledger remains available; successful retry then erases and purges exact identity export.                                                                                       |
| Archive and recovery           | PASS: actual ciphertext encryption/checksum/authenticated recovery and equal recovered ledger; older custom-format database dump restored; recovered ledger replay pending 3 then 0. API/bot remain stopped throughout. No application startup/readiness is exercised.                  |
| Archive transport              | Existing `rclone` test fixture copies to a protected **local** directory. This is not proof of remote/off-host durability, cloud permissions or production storage.                                                                                                                     |
| Wrapper/crypto/export fixtures | PASS; running-app refusal, missing destination, protected-file retention/scoped purge, wrong-key/tamper rejection and secret-safe errors. Docker/CLI transport in these separate shell fixtures is mocked.                                                                              |
| Focused Jest                   | PASS, 5 suites/59 tests. Initial root-directory invocation failed configuration resolution before tests; corrected backend-directory invocation passed.                                                                                                                                 |
| Connector contracts            | PASS 7; one native-PHP check skipped by host Node runner because host PHP is unavailable. Separately executed cached PHP 8.4 reconciliation fixture: PASS, including unreadable-salt retry failure, complete hook enumeration and exact uninstall selection.                            |
| WordPress recovery/site        | NOT EXECUTED: no authorized disposable WordPress/WooCommerce site available. Same-Store protected M8/M7 bridge is documented design only; health/real ingestion and negative old-credential tests remain site prerequisites.                                                            |

The account runner uses 0700/0600 temporary directories/files, automatically
removes its generated PostgreSQL container and tears down only its explicit
generated Compose project/network in a `finally` block. The current runner
leaves PostgreSQL volumes in place; no volume pruning or deletion is authorized.
The validation reported above predates this cleanup-only restriction; the
restricted cleanup has not been rerun. Backup bytes, keys,
credentials, exports and encrypted test archives are temporary test data, not
committed artifacts. Safe output markers are `pilot account integration: PASS`
and `pilot account wrapper: PASS`. The exact documented PHP bridge also passed PHP 8.4 syntax lint only; it was
not executed. Final inventory showed no `wctm-account` containers or generated
`wctm-account-wrapper` networks. No production or merchant site was accessed.
Earlier runs before the `--volumes` cleanup correction may have left anonymous synthetic PostgreSQL volumes; attribution/removal was not verified, and no broad volume deletion was attempted.

## Prepared production checklist — do not execute from this evidence

A owns authorization and acceptance for every production step. Reference
[P7_2_P7_3_RUNBOOK.md](../operations/P7_2_P7_3_RUNBOOK.md),
[PPR2_DATA_PROTECTION.md](PPR2_DATA_PROTECTION.md) and
[WORDPRESS_CONNECTOR_VALIDATION.md](WORDPRESS_CONNECTOR_VALIDATION.md).

- Establish independently reviewed revision, protected migration/runtime key
  continuity, fresh encrypted verified off-host backup and restored erasure
  ledger. Keep API/bot stopped during restore; dry-run and execute ledger replay
  before any application startup. Missing/inconsistent evidence stops recovery.
- `deploy-production.sh` handles revision lock, backup, image build, migrations,
  API/bot recreation, readiness and restricted-role verification. It does **not**
  recreate Redis. Redis configuration application/recreation needs a separate
  explicit A-approved step preserving the verified existing Redis volume.
- After approved Redis configuration application, record `CONFIG GET appendonly
auto-aof-rewrite-percentage auto-aof-rewrite-min-size`: expected `yes`, `100`,
  `67108864`. Record `INFO persistence` before/after an observed successful rewrite,
  including rewrite running/scheduled flags, last rewrite status/time and AOF
  size. Thresholds are growth-based; they do not certify calendar-bounded byte
  erasure or removal from older backups/storage snapshots.
- Record approved API/bot startup, local/public health/readiness, role checks,
  bounded functional smoke and post-operation backup as distinct evidence.
  Complete actual disposable-site recovery/ingestion and review outstanding
  privacy gates before A can consider onboarding. No checklist step above was
  executed against production during this session.
