#!/usr/bin/env bash
set -euo pipefail

fixture=$(realpath scripts/ops/test-fixtures/rclone)
workspace=$(mktemp -d)
trap 'chmod 0600 "$workspace/rclone.conf" 2>/dev/null || true; rm -rf -- "$workspace"' EXIT
mkdir -p "$workspace/scripts/ops" "$workspace/bin" "$workspace/backups"
cp scripts/ops/scheduled-backup.sh scripts/ops/offsite-rclone.sh "$workspace/scripts/ops/"

cat >"$workspace/scripts/ops/backup-postgres.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'backup\n' >>"$TEST_WORKSPACE/operations.log"
dump="$TEST_WORKSPACE/backups/test.dump"
printf 'local test dump\n' >"$dump"
(cd "$(dirname "$dump")" && sha256sum "$(basename "$dump")" >"$dump.sha256")
printf '{}\n' >"$dump.json"
printf '%s\n' "$dump" >"$WCTM_BACKUP_RESULT_FILE"
SH
cat >"$workspace/scripts/ops/backup-retention.sh" <<'SH'
#!/usr/bin/env bash
printf 'retention\n' >>"$TEST_WORKSPACE/operations.log"
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
chmod +x "$workspace"/scripts/ops/*.sh "$workspace/bin/rclone"

export TEST_WORKSPACE=$workspace TEST_RCLONE_FIXTURE=$fixture
export TEST_EXPECTED_CONFIG="$workspace/rclone.conf"
export WCTM_BACKUP_DIRECTORY="$workspace/backups"
export PATH="$workspace/bin:$PATH"
printf '[testremote]\ntype = local\n' >"$TEST_EXPECTED_CONFIG"
chmod 0600 "$TEST_EXPECTED_CONFIG"
export RCLONE_CONFIG=$TEST_EXPECTED_CONFIG

run_scheduled() {
  (cd "$workspace" && scripts/ops/scheduled-backup.sh)
}

export WCTM_OFFSITE_DESTINATION="testremote:$workspace/native"
run_scheduled >"$workspace/native.log" 2>&1
grep -q 'content_sha256=verified method=native-sha256' "$workspace/native.log"
[[ -f "$workspace/native/test.dump" && -f "$workspace/native/test.dump.json" && -f "$workspace/native/test.dump.sha256" ]]

export WCTM_OFFSITE_DESTINATION="testremote:$workspace/streamed"
WCTM_TEST_RCLONE_NATIVE_HASH=unavailable run_scheduled >"$workspace/streamed.log" 2>&1
grep -q 'content_sha256=verified method=streamed-sha256' "$workspace/streamed.log"

export WCTM_OFFSITE_DESTINATION="testremote:$workspace/corrupt"
if WCTM_TEST_RCLONE_NATIVE_HASH=unavailable WCTM_TEST_RCLONE_CORRUPT_DUMP=true \
  run_scheduled >"$workspace/corrupt.log" 2>&1; then
  echo >&2 'test failed: same-size remote corruption was accepted'
  exit 1
fi
[[ $(wc -c <"$workspace/corrupt/test.dump" | tr -d ' ') = $(wc -c <"$workspace/backups/test.dump" | tr -d ' ') ]]
grep -q 'remote dump SHA-256 mismatch' "$workspace/corrupt.log"

backup_calls=$(grep -c '^backup$' "$workspace/operations.log")
RCLONE_CONFIG='' run_scheduled >"$workspace/missing.log" 2>&1 && {
  echo >&2 'test failed: missing RCLONE_CONFIG was accepted'
  exit 1
}
grep -q 'RCLONE_CONFIG must be an absolute path to a readable regular file' "$workspace/missing.log"

chmod 000 "$TEST_EXPECTED_CONFIG"
[[ ! -r "$TEST_EXPECTED_CONFIG" ]] || {
  echo >&2 'test setup failed: config file is still readable'
  exit 1
}
if run_scheduled >"$workspace/unreadable.log" 2>&1; then
  echo >&2 'test failed: unreadable RCLONE_CONFIG was accepted'
  exit 1
fi
grep -q 'RCLONE_CONFIG must be an absolute path to a readable regular file' "$workspace/unreadable.log"
[[ $(grep -c '^backup$' "$workspace/operations.log") = "$backup_calls" ]]

echo 'scheduled backup: PASS configured-rclone-path missing/unreadable-rejected native/streamed-SHA-256 same-size-corruption-rejected'
