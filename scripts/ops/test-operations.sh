#!/usr/bin/env bash
set -euo pipefail
umask 077

image='postgres:16.15-alpine3.24@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
suffix="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
source_container="wctm-ops-test-$suffix"
source_volume="wctm_ops_test_$suffix"
source_network="wctm_ops_test_$suffix"
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
remote_corrupt="$workspace/offsite-corrupt/$(basename "$backup")"
[[ $(wc -c <"$remote_corrupt" | tr -d ' ') = $(wc -c <"$backup" | tr -d ' ') ]]
[[ $(sha256sum "$remote_corrupt" | awk '{print $1}') != $(sha256sum "$backup" | awk '{print $1}') ]]
grep -q 'remote dump SHA-256 mismatch' "$workspace/offsite-corrupt.log"
! grep -q "$secret_marker" "$workspace/offsite-native.log" "$workspace/offsite-streamed.log" "$workspace/offsite-corrupt.log"

if ! scripts/ops/restore-isolated.sh --backup "$backup" --critical-table tenants --critical-table stores --critical-table operations_probe >"$workspace/restore.log" 2>&1; then
  cat "$workspace/restore.log" >&2
  exit 1
fi
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

echo 'operations integration: PASS migration-twice backup restore data checksum corruption retention offsite-native-sha256 offsite-streamed-sha256 offsite-same-size-corruption-rejected identity-boundary secret-safe-logs'
