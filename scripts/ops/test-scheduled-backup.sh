#!/usr/bin/env bash
set -euo pipefail

fixture=$(realpath scripts/ops/test-fixtures/rclone)
export TEST_DOCKER_NODE_FIXTURE="$(pwd -P)/scripts/ops/test-fixtures/docker-node-run.sh"
export TEST_NODE=$(command -v node)
workspace=$(mktemp -d)
trap 'chmod 0600 "$workspace/rclone.conf" "$workspace/.env" 2>/dev/null || true; rm -rf -- "$workspace"' EXIT
mkdir -p "$workspace/scripts/ops" "$workspace/bin" "$workspace/backups"
cp scripts/ops/scheduled-backup.sh scripts/ops/backup-postgres.sh \
  scripts/ops/offsite-rclone.sh scripts/ops/offsite-retention.sh \
  scripts/ops/decrypt-offsite.sh \
  scripts/ops/run-ops-node.sh scripts/ops/backup-crypto.mjs \
  scripts/ops/select-offsite-expired.mjs "$workspace/scripts/ops/"

cat >"$workspace/scripts/ops/backup-retention.sh" <<'SH'
#!/usr/bin/env bash
printf 'retention\n' >>"$TEST_WORKSPACE/operations.log"
SH
cat >"$workspace/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$TEST_WORKSPACE/docker.log"
case "${1:-}" in
  ps)
    [[ "$*" = "ps --no-trunc --filter label=com.docker.compose.project=wctm --filter label=com.docker.compose.service=postgres --format {{.ID}}" ]] || exit 99
    case "${TEST_CONTAINER_MATCHES:-one}" in
      one) printf '%s\n' "$TEST_EXPECTED_CONTAINER" ;;
      none) ;;
      multiple) printf '%s\n%s\n' "$TEST_EXPECTED_CONTAINER" "$TEST_SECOND_CONTAINER" ;;
      *) exit 99 ;;
    esac
    ;;
  exec)
    shift
    if [[ "${1:-}" = -i ]]; then
      shift
      [[ "${1:-}" = "$TEST_EXPECTED_CONTAINER" && "${2:-}" = pg_restore && "${3:-}" = --list ]] || exit 99
      cat >/dev/null
      exit 0
    fi
    [[ "${1:-}" = "$TEST_EXPECTED_CONTAINER" ]] || exit 99
    shift
    if [[ "${1:-}" = pg_dump && "${2:-}" = --version ]]; then
      printf 'pg_dump (PostgreSQL) 16.15\n'
      exit 0
    fi
    [[ "${1:-}" = sh && "${2:-}" = -c ]] || exit 99
    case "${3:-}" in
      *'current_database()'*) printf 'wctm_test\n' ;;
      *'_prisma_migrations'*) printf '16\n' ;;
      *'show server_version'*) printf '16.15\n' ;;
      *'pg_dump -U'*) printf 'PGDMP synthetic local test data\n' ;;
      *) exit 99 ;;
    esac
    ;;
  compose)
    echo >&2 'test failed: scheduled backup invoked Docker Compose'
    exit 99
    ;;
  run)
    exec "$TEST_DOCKER_NODE_FIXTURE" "$@"
    ;;
  image)
    exec "$TEST_DOCKER_NODE_FIXTURE" "$@"
    ;;
  *) exit 99 ;;
esac
SH
cat >"$workspace/bin/git" <<'SH'
#!/usr/bin/env bash
[[ "$*" = 'rev-parse HEAD' ]] || exit 99
printf '%s\n' '123456789abcdef0123456789abcdef012345678'
SH
cat >"$workspace/bin/rclone" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ ${RCLONE_CONFIG:-} = "$TEST_EXPECTED_CONFIG" ]] || {
  echo >&2 'test failed: rclone did not receive configured path'
  exit 1
}
exec "$TEST_RCLONE_FIXTURE" "$@"
SH
chmod +x "$workspace"/scripts/ops/*.sh "$workspace"/bin/*
ln -s "$(command -v sha256sum)" "$workspace/bin/sha256sum"

export TEST_WORKSPACE=$workspace TEST_RCLONE_FIXTURE=$fixture
export TEST_EXPECTED_CONFIG="$workspace/rclone.conf"
export TEST_EXPECTED_CONTAINER=$(printf 'a%.0s' {1..64})
export TEST_SECOND_CONTAINER=$(printf 'b%.0s' {1..64})
export WCTM_BACKUP_DIRECTORY="$workspace/backups"
export WCTM_COMPOSE_PROJECT=wctm
export PATH="$workspace/bin:/usr/bin:/bin"
! command -v node >/dev/null 2>&1
printf '[testremote]\ntype = local\n' >"$TEST_EXPECTED_CONFIG"
chmod 0600 "$TEST_EXPECTED_CONFIG"
export RCLONE_CONFIG=$TEST_EXPECTED_CONFIG
openssl rand 32 >"$workspace/backup.key"
chmod 0600 "$workspace/backup.key"
export WCTM_BACKUP_CRYPTO_KEY_FILE="$workspace/backup.key"
printf 'unreadable production env sentinel\n' >"$workspace/.env"
chmod 000 "$workspace/.env"
[[ ! -r "$workspace/.env" ]] || {
  echo >&2 'test setup failed: .env is still readable'
  exit 1
}

run_scheduled() {
  (cd "$workspace" && scripts/ops/scheduled-backup.sh)
}

export WCTM_OFFSITE_DESTINATION="testremote:$workspace/native"
run_scheduled >"$workspace/native.log" 2>&1
grep -q 'content_sha256=verified method=native-sha256' "$workspace/native.log"
dump=$(find "$workspace/backups" -maxdepth 1 -name 'wctm-postgres-*.dump' -print)
[[ -n "$dump" && -f "$dump.json" && -f "$dump.sha256" ]]
(cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256") >/dev/null
grep -q '"format": "postgresql-custom"' "$dump.json"
grep -q '"completedMigrationCount": 16' "$dump.json"
[[ -f "$workspace/native/$(basename "$dump").enc" && -f "$workspace/native/$(basename "$dump").enc.json" && -f "$workspace/native/$(basename "$dump").enc.sha256" ]]
[[ ! -e "$workspace/native/$(basename "$dump")" ]]
mkdir "$workspace/decrypted"
(cd "$workspace" && scripts/ops/decrypt-offsite.sh \
  "$workspace/native/$(basename "$dump").enc" \
  "$workspace/native/$(basename "$dump").enc.json" \
  "$workspace/decrypted") >"$workspace/decrypt.log" 2>&1
cmp "$dump" "$workspace/decrypted/$(basename "$dump")"
if grep -q '^compose ' "$workspace/docker.log"; then
  echo >&2 'test failed: backup required Docker Compose and its .env'
  exit 1
fi

rm -f "$workspace/backups"/wctm-postgres-*.dump*
export WCTM_OFFSITE_DESTINATION="testremote:$workspace/streamed"
WCTM_TEST_RCLONE_NATIVE_HASH=unavailable run_scheduled >"$workspace/streamed.log" 2>&1
grep -q 'content_sha256=verified method=streamed-sha256' "$workspace/streamed.log"

rm -f "$workspace/backups"/wctm-postgres-*.dump*
export WCTM_OFFSITE_DESTINATION="testremote:$workspace/corrupt"
if WCTM_TEST_RCLONE_NATIVE_HASH=unavailable WCTM_TEST_RCLONE_CORRUPT_DUMP=true \
  run_scheduled >"$workspace/corrupt.log" 2>&1; then
  echo >&2 'test failed: same-size remote corruption was accepted'
  exit 1
fi
dump=$(find "$workspace/backups" -maxdepth 1 -name 'wctm-postgres-*.dump' -print)
[[ -s "$workspace/corrupt/$(basename "$dump").enc" ]]
grep -q 'remote encrypted dump SHA-256 mismatch' "$workspace/corrupt.log"

docker_calls=$(wc -l <"$workspace/docker.log" | tr -d ' ')
WCTM_BACKUP_DIRECTORY='' run_scheduled >"$workspace/missing-backup-directory.log" 2>&1 && {
  echo >&2 'test failed: missing backup directory was accepted'
  exit 1
}
grep -q 'WCTM_BACKUP_DIRECTORY is required' "$workspace/missing-backup-directory.log"
WCTM_COMPOSE_PROJECT='' run_scheduled >"$workspace/missing-project.log" 2>&1 && {
  echo >&2 'test failed: missing Compose project was accepted'
  exit 1
}
grep -q 'WCTM_COMPOSE_PROJECT must name the reviewed Compose project' "$workspace/missing-project.log"
[[ $(wc -l <"$workspace/docker.log" | tr -d ' ') = "$docker_calls" ]]

TEST_CONTAINER_MATCHES=none run_scheduled >"$workspace/no-container.log" 2>&1 && {
  echo >&2 'test failed: missing PostgreSQL container was accepted'
  exit 1
}
grep -q 'expected exactly one running PostgreSQL container' "$workspace/no-container.log"
TEST_CONTAINER_MATCHES=multiple run_scheduled >"$workspace/multiple-containers.log" 2>&1 && {
  echo >&2 'test failed: ambiguous PostgreSQL container was accepted'
  exit 1
}
grep -q 'expected exactly one running PostgreSQL container' "$workspace/multiple-containers.log"

RCLONE_CONFIG='' run_scheduled >"$workspace/missing-rclone.log" 2>&1 && {
  echo >&2 'test failed: missing RCLONE_CONFIG was accepted'
  exit 1
}
grep -q 'RCLONE_CONFIG must be an absolute path to a readable regular file' "$workspace/missing-rclone.log"
chmod 000 "$TEST_EXPECTED_CONFIG"
[[ ! -r "$TEST_EXPECTED_CONFIG" ]] || {
  echo >&2 'test setup failed: rclone config is still readable'
  exit 1
}
if run_scheduled >"$workspace/unreadable-rclone.log" 2>&1; then
  echo >&2 'test failed: unreadable RCLONE_CONFIG was accepted'
  exit 1
fi
grep -q 'RCLONE_CONFIG must be an absolute path to a readable regular file' "$workspace/unreadable-rclone.log"

if grep -q 'unreadable production env sentinel' "$workspace"/*.log; then
  echo >&2 'test failed: production env content reached a log'
  exit 1
fi
if grep -q 'scheduled backup: PASS' "$workspace/corrupt.log" "$workspace/missing-backup-directory.log" "$workspace/missing-project.log" "$workspace/no-container.log" "$workspace/multiple-containers.log" "$workspace/missing-rclone.log" "$workspace/unreadable-rclone.log"; then
  echo >&2 'test failed: unsuccessful backup reported PASS'
  exit 1
fi
echo 'scheduled backup: PASS no-host-node no-compose-env exact-container missing-config rclone-path custom-format SHA-256 offsite-integrity secret-safe-logs'
