#!/usr/bin/env bash
set -euo pipefail
umask 077

image='postgres:16.15-alpine3.24@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
suffix="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
source_container="wctm-ops-test-$suffix"
source_volume="wctm_ops_test_$suffix"
source_network="wctm_ops_test_$suffix"
privacy_volume="wctm_privacy_test_$suffix"
workspace=$(mktemp -d)
secret_marker='test-password-must-not-appear'

cleanup() {
  docker rm --force "$source_container" >/dev/null 2>&1 || true
  case "$source_volume" in
    wctm_ops_test_*) docker volume rm "$source_volume" >/dev/null 2>&1 || true ;;
  esac
  case "$source_network" in
    wctm_ops_test_*) docker network rm "$source_network" >/dev/null 2>&1 || true ;;
  esac
  case "$privacy_volume" in
    wctm_privacy_test_*) docker volume rm "$privacy_volume" >/dev/null 2>&1 || true ;;
  esac
  rm -rf -- "$workspace"
}
trap cleanup EXIT HUP INT TERM

for script in scripts/ops/*.sh; do
  case "$script" in
    *run-migrations.sh|*migrate-production.sh|*verify-runtime-role.sh|*deploy-production.sh) sh -n "$script" ;;
    *) bash -n "$script" ;;
  esac
done
bash -n scripts/ops/test-fixtures/rclone
docker compose config --quiet
docker compose build migrate >/dev/null
docker compose build backend >/dev/null
[[ $(docker run --rm --entrypoint id wctm-migrate:latest -u) = 1000 ]]

if WCTM_MIGRATION_OPERATION=P7_2_EXPLICIT_MIGRATION DATABASE_URL='postgresql://wctm_runtime:sentinel@postgres/db' scripts/ops/run-migrations.sh >"$workspace/migration.log" 2>&1; then
  echo >&2 'test failed: migration entrypoint accepted runtime identity'
  exit 1
fi
grep -q 'distinct PostgreSQL migration identity' "$workspace/migration.log"
! grep -q 'sentinel' "$workspace/migration.log"
if WCTM_MIGRATION_OPERATION=P7_2_EXPLICIT_MIGRATION DATABASE_URL='postgresql://wctm%5Fruntime:sentinel@postgres/db' scripts/ops/run-migrations.sh >"$workspace/migration-encoded.log" 2>&1; then
  echo >&2 'test failed: migration entrypoint accepted encoded runtime identity'
  exit 1
fi
! grep -q 'sentinel' "$workspace/migration-encoded.log"

mkdir "$workspace/retention"
for stamp in 20260101T000000Z 20260102T000000Z 20260103T000000Z; do
  file="$workspace/retention/wctm-postgres-$stamp-deadbeef0000.dump"
  printf '%s\n' "$stamp" >"$file"
  printf '{}\n' >"$file.json"
  (cd "$(dirname "$file")" && sha256sum "$(basename "$file")" >"$(basename "$file").sha256")
done
printf 'unrelated\n' >"$workspace/retention/do-not-delete.dump"
scripts/ops/backup-retention.sh --directory "$workspace/retention" --keep 1 >"$workspace/retention-dry.log"
[[ $(find "$workspace/retention" -name 'wctm-postgres-*.dump' | wc -l | tr -d ' ') = 3 ]]
scripts/ops/backup-retention.sh --directory "$workspace/retention" --keep 1 --apply >"$workspace/retention-apply.log"
[[ -f "$workspace/retention/wctm-postgres-20260103T000000Z-deadbeef0000.dump" ]]
[[ -f "$workspace/retention/do-not-delete.dump" ]]
[[ $(find "$workspace/retention" -name 'wctm-postgres-*.dump' | wc -l | tr -d ' ') = 1 ]]

docker volume create "$source_volume" >/dev/null
docker network create "$source_network" >/dev/null
docker run -d --name "$source_container" --network "$source_network" --network-alias postgres \
  --mount "type=volume,source=$source_volume,destination=/var/lib/postgresql/data" \
  -e POSTGRES_DB=wctm_ops_test -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$secret_marker" \
  "$image" >/dev/null
stable_ready=0
for _ in $(seq 1 60); do
  if docker exec "$source_container" pg_isready -U postgres -d wctm_ops_test >/dev/null 2>&1; then
    stable_ready=$((stable_ready + 1))
    ((stable_ready >= 3)) && break
  else
    stable_ready=0
  fi
  sleep 1
done
((stable_ready >= 3))

for attempt in 1 2; do
  docker run --rm --network "$source_network" \
    -e WCTM_MIGRATION_OPERATION=P7_2_EXPLICIT_MIGRATION \
    -e "DATABASE_URL=postgresql://postgres:$secret_marker@postgres:5432/wctm_ops_test" \
    wctm-migrate:latest >"$workspace/migration-$attempt.log" 2>&1
  ! grep -q "$secret_marker" "$workspace/migration-$attempt.log"
done
[[ $(docker exec "$source_container" psql -XAtq -v ON_ERROR_STOP=1 -U postgres -d wctm_ops_test -c 'select count(*) from public._prisma_migrations where finished_at is not null and rolled_back_at is null') = 16 ]]

docker exec -i "$source_container" psql -X -v ON_ERROR_STOP=1 -U postgres -d wctm_ops_test >/dev/null <<'SQL'
CREATE TABLE operations_probe (id integer PRIMARY KEY, value text NOT NULL);
INSERT INTO operations_probe VALUES (1, 'survives-backup-and-restore');
SQL

mkdir "$workspace/backups"
WCTM_POSTGRES_CONTAINER=$source_container scripts/ops/backup-postgres.sh --destination "$workspace/backups" >"$workspace/backup.log" 2>&1
! grep -q "$secret_marker" "$workspace/backup.log"
backup=$(find "$workspace/backups" -maxdepth 1 -name 'wctm-postgres-*.dump' -print)
[[ -n "$backup" && -f "$backup.sha256" && -f "$backup.json" ]]

mkdir "$workspace/test-bin" "$workspace/offsite-native" "$workspace/offsite-streamed" "$workspace/offsite-corrupt"
openssl rand 32 >"$workspace/backup.key"
chmod 0600 "$workspace/backup.key"
export WCTM_BACKUP_CRYPTO_KEY_FILE="$workspace/backup.key"
cp scripts/ops/test-fixtures/rclone "$workspace/test-bin/rclone"
chmod 0700 "$workspace/test-bin/rclone"
PATH="$workspace/test-bin:$PATH" scripts/ops/offsite-rclone.sh \
  "$backup" "$backup.sha256" "$backup.json" "testremote:$workspace/offsite-native" \
  >"$workspace/offsite-native.log" 2>&1
grep -q 'content_sha256=verified method=native-sha256' "$workspace/offsite-native.log"
WCTM_TEST_RCLONE_NATIVE_HASH=unavailable PATH="$workspace/test-bin:$PATH" \
  scripts/ops/offsite-rclone.sh \
  "$backup" "$backup.sha256" "$backup.json" "testremote:$workspace/offsite-streamed" \
  >"$workspace/offsite-streamed.log" 2>&1
grep -q 'content_sha256=verified method=streamed-sha256' "$workspace/offsite-streamed.log"
if WCTM_TEST_RCLONE_NATIVE_HASH=unavailable WCTM_TEST_RCLONE_CORRUPT_DUMP=true \
  PATH="$workspace/test-bin:$PATH" scripts/ops/offsite-rclone.sh \
  "$backup" "$backup.sha256" "$backup.json" "testremote:$workspace/offsite-corrupt" \
  >"$workspace/offsite-corrupt.log" 2>&1; then
  echo >&2 'test failed: same-size remote corruption was accepted'
  exit 1
fi
remote_corrupt="$workspace/offsite-corrupt/$(basename "$backup").enc"
[[ -s "$remote_corrupt" ]]
grep -q 'remote encrypted dump SHA-256 mismatch' "$workspace/offsite-corrupt.log"
! grep -q "$secret_marker" "$workspace/offsite-native.log" "$workspace/offsite-streamed.log" "$workspace/offsite-corrupt.log"

if ! scripts/ops/restore-isolated.sh --backup "$backup" --critical-table tenants --critical-table stores --critical-table operations_probe >"$workspace/restore.log" 2>&1; then
  cat "$workspace/restore.log" >&2
  exit 1
fi
mkdir "$workspace/decrypted"
scripts/ops/decrypt-offsite.sh \
  "$workspace/offsite-streamed/$(basename "$backup").enc" \
  "$workspace/offsite-streamed/$(basename "$backup").enc.json" \
  "$workspace/decrypted" >"$workspace/decrypt.log" 2>&1
cmp "$backup" "$workspace/decrypted/$(basename "$backup")"
scripts/ops/restore-isolated.sh --backup "$workspace/decrypted/$(basename "$backup")" \
  --critical-table operations_probe >"$workspace/restore-offsite.log" 2>&1
grep -q 'isolated restore: PASS migrations=16' "$workspace/restore-offsite.log"
grep -q 'isolated restore: PASS migrations=16' "$workspace/restore.log"
grep -q 'critical table: tenants rows=0' "$workspace/restore.log"
grep -q 'critical table: stores rows=0' "$workspace/restore.log"
grep -q 'critical table: operations_probe rows=1' "$workspace/restore.log"
! grep -q "$secret_marker" "$workspace/restore.log"

mkdir "$workspace/corrupt"
corrupt_backup="$workspace/corrupt/$(basename "$backup")"
cp "$backup" "$corrupt_backup"
cp "$backup.sha256" "$corrupt_backup.sha256"
cp "$backup.json" "$corrupt_backup.json"
printf 'corruption\n' >>"$corrupt_backup"
if scripts/ops/restore-isolated.sh --backup "$corrupt_backup" >"$workspace/corrupt.log" 2>&1; then
  echo >&2 'test failed: corrupted backup was accepted'
  exit 1
fi

docker exec -i "$source_container" psql -X -v ON_ERROR_STOP=1 -U postgres -d wctm_ops_test >/dev/null <<'SQL'
INSERT INTO tenants (id, name, updated_at)
VALUES ('ten_privacy_a', 'Privacy A', now()), ('ten_privacy_b', 'Privacy B', now());
INSERT INTO stores (id, tenant_id, name, base_url, status, consumer_key_encrypted, consumer_secret_encrypted, updated_at)
VALUES ('sto_privacy_a', 'ten_privacy_a', 'Store A', 'https://a.example.test', 'ACTIVE', 'fixture', 'fixture', now()),
       ('sto_privacy_b', 'ten_privacy_b', 'Store B', 'https://b.example.test', 'ACTIVE', 'fixture', 'fixture', now());
INSERT INTO webhook_events (id, tenant_id, store_id, webhook_id, delivery_id, dedupe_key, topic, payload, status, updated_at)
VALUES ('evt_privacy_a', 'ten_privacy_a', 'sto_privacy_a', '42', 'delivery-a', 'delivery-a',
        'order.updated', '{"id":12,"billing":{"email":"fixture@example.test"}}', 'COMPLETED', now());
SQL
docker volume create "$privacy_volume" >/dev/null
docker run --rm --network none --user root --mount "type=volume,source=$privacy_volume,destination=/privacy" \
  --entrypoint sh wctm-backend:latest -c 'chown node:node /privacy && chmod 0700 /privacy' >/dev/null
docker run --rm --network none --mount "type=volume,source=$privacy_volume,destination=/privacy" \
  --entrypoint sh wctm-backend:latest -c 'umask 077; : > /privacy/erasure-ledger.jsonl' >/dev/null
privacy_database_url="postgresql://postgres:$secret_marker@postgres:5432/wctm_ops_test"
privacy_key=$(openssl rand -base64 32)
privacy_cli() {
  docker run --rm --network "$source_network" \
    --mount "type=volume,source=$privacy_volume,destination=/privacy" \
    -e "DATABASE_URL=$privacy_database_url" -e "APP_ENCRYPTION_KEY=$privacy_key" \
    -e WCTM_PILOT_PRIVACY_OPERATION=operator-approved \
    --entrypoint node wctm-backend:latest dist/privacy/pilot-data.cli.js "$@"
}
privacy_target=(--tenant-id ten_privacy_a --store-id sto_privacy_a --base-url https://a.example.test)
privacy_cli inspect "${privacy_target[@]}" >"$workspace/privacy-inspect.log" 2>&1
privacy_cli scrub "${privacy_target[@]}" --execute >"$workspace/privacy-scrub.log" 2>&1
[[ $(docker exec "$source_container" psql -XAtq -U postgres -d wctm_ops_test -c "select payload ? 'billing' from webhook_events where id='evt_privacy_a'") = t ]]
[[ $(docker exec "$source_container" psql -XAtq -U postgres -d wctm_ops_test -c "select payload->'billing' ? 'email' from webhook_events where id='evt_privacy_a'") = f ]]
if privacy_cli erase --tenant-id ten_privacy_b --store-id sto_privacy_a \
  --base-url https://a.example.test --ledger /privacy/erasure-ledger.jsonl --execute \
  >"$workspace/privacy-cross-tenant.log" 2>&1; then
  echo >&2 'test failed: cross-tenant privacy erasure was accepted'
  exit 1
fi
privacy_cli disconnect "${privacy_target[@]}" --execute >"$workspace/privacy-disconnect.log" 2>&1
privacy_cli prepare-erasure "${privacy_target[@]}" --ledger /privacy/erasure-ledger.jsonl --execute \
  >"$workspace/privacy-prepare.log" 2>&1
privacy_cli erase "${privacy_target[@]}" --ledger /privacy/erasure-ledger.jsonl --execute \
  >"$workspace/privacy-erase.log" 2>&1
[[ $(docker exec "$source_container" psql -XAtq -U postgres -d wctm_ops_test -c "select base_url from stores where id='sto_privacy_a'") = https://erased.invalid/sto_privacy_a ]]
[[ $(docker exec "$source_container" psql -XAtq -U postgres -d wctm_ops_test -c "select base_url from stores where id='sto_privacy_b'") = https://b.example.test ]]
docker exec -i "$source_container" psql -X -v ON_ERROR_STOP=1 -U postgres -d wctm_ops_test >/dev/null <<'SQL'
UPDATE stores SET name='Store A', base_url='https://a.example.test', status='ACTIVE', deleted_at=NULL
WHERE id='sto_privacy_a';
UPDATE webhook_events SET payload='{"id":12,"billing":{"email":"fixture@example.test"}}'
WHERE id='evt_privacy_a';
SQL
privacy_cli replay --ledger /privacy/erasure-ledger.jsonl --execute >"$workspace/privacy-replay.log" 2>&1
[[ $(docker exec "$source_container" psql -XAtq -U postgres -d wctm_ops_test -c "select base_url from stores where id='sto_privacy_a'") = https://erased.invalid/sto_privacy_a ]]
[[ $(docker exec "$source_container" psql -XAtq -U postgres -d wctm_ops_test -c "select payload from webhook_events where id='evt_privacy_a'") = '{}' ]]
! grep -q "$secret_marker" "$workspace"/privacy-*.log

echo 'operations integration: PASS migration-twice backup restore data checksum corruption retention encrypted-offsite-sha256 cross-tenant-erasure privacy-scrub disconnect erasure ledger-replay identity-boundary secret-safe-logs'
