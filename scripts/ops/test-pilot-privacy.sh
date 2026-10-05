#!/usr/bin/env bash
set -euo pipefail
umask 077

workspace=$(mktemp -d)
trap 'rm -rf -- "$workspace"' EXIT HUP INT TERM
mkdir -m 0700 "$workspace/privacy" "$workspace/bin" "$workspace/remote"
printf 'DATABASE_URL=postgresql://owner:fixture-only@postgres/wctm\n' >"$workspace/database.conf"
printf '{"tenantId":"ten_fixture","storeId":"sto_fixture","baseUrlSha256":"%064d"}\n' 0 \
  >"$workspace/privacy/erasure-ledger.jsonl"
openssl rand 32 >"$workspace/key"
printf '[testremote]\ntype = local\n' >"$workspace/rclone.conf"
cp scripts/ops/test-fixtures/rclone "$workspace/bin/rclone"
cat >"$workspace/bin/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$TEST_DOCKER_LOG"
if [[ "$*" = 'compose ps --status running -q backend telegram-bot' &&
  ${TEST_APP_RUNNING:-false} = true ]]; then
  printf 'running-container\n'
fi
SH
chmod 0700 "$workspace/bin/docker" "$workspace/bin/rclone"
export PATH="$workspace/bin:$PATH"
export TEST_DOCKER_LOG="$workspace/docker.log"
export WCTM_BACKUP_CRYPTO_KEY_FILE="$workspace/key"
export RCLONE_CONFIG="$workspace/rclone.conf"
export WCTM_OFFSITE_DESTINATION="testremote:$workspace/remote"

scripts/ops/pilot-privacy.sh --credential-file "$workspace/database.conf" \
  --privacy-directory "$workspace/privacy" -- inspect \
  --tenant-id ten_fixture --store-id sto_fixture --base-url https://fixture.test \
  >"$workspace/inspect.log"
[[ $(wc -l <"$workspace/docker.log" | tr -d ' ') = 1 ]]

scripts/ops/pilot-privacy.sh --credential-file "$workspace/database.conf" \
  --privacy-directory "$workspace/privacy" -- erase \
  --tenant-id ten_fixture --store-id sto_fixture --base-url https://fixture.test --execute \
  >"$workspace/erase.log"
grep -q 'pilot-data.cli.js prepare-erasure' "$workspace/docker.log"
grep -q 'pilot-data.cli.js erase' "$workspace/docker.log"
grep -q 'erasure archive: PASS' "$workspace/erase.log"
[[ $(find "$workspace/remote/privacy-erasure-ledger" -name '*.jsonl.enc' | wc -l | tr -d ' ') = 1 ]]
! grep -q 'fixture-only' "$workspace"/*.log

unset WCTM_OFFSITE_DESTINATION
if scripts/ops/pilot-privacy.sh --credential-file "$workspace/database.conf" \
  --privacy-directory "$workspace/privacy" -- erase \
  --tenant-id ten_fixture --store-id sto_fixture --base-url https://fixture.test --execute \
  >"$workspace/missing.log" 2>&1; then
  echo >&2 'test failed: erasure proceeded without off-site ledger destination'
  exit 1
fi
[[ $(wc -l <"$workspace/docker.log" | tr -d ' ') = 5 ]]

export WCTM_OFFSITE_DESTINATION="testremote:$workspace/remote"
if TEST_APP_RUNNING=true scripts/ops/pilot-privacy.sh \
  --credential-file "$workspace/database.conf" \
  --privacy-directory "$workspace/privacy" -- disconnect \
  --tenant-id ten_fixture --store-id sto_fixture --base-url https://fixture.test --execute \
  >"$workspace/running.log" 2>&1; then
  echo >&2 'test failed: disconnect ran while application services were running'
  exit 1
fi
grep -q 'stop backend and bot' "$workspace/running.log"
echo 'pilot privacy wrapper: PASS protected-config dry-run archive-before-erasure fail-closed'
