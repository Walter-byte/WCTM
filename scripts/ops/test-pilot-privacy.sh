#!/usr/bin/env bash
set -euo pipefail
umask 077

workspace=$(mktemp -d)
trap 'rm -rf -- "$workspace"' EXIT HUP INT TERM
export TEST_NODE=$(command -v node)
export TEST_DOCKER_NODE_FIXTURE="$(pwd -P)/scripts/ops/test-fixtures/docker-node-run.sh"
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
if [[ ${1:-} = run || ( ${1:-} = image && ${2:-} = inspect ) ]]; then
  exec "$TEST_DOCKER_NODE_FIXTURE" "$@"
fi
previous=''
for argument in "$@"; do
  if [[ "$previous" = --output ]]; then
    printf 'fixture private export\n' >"$argument"
    chmod 0600 "$argument"
  fi
  previous=$argument
done
if [[ "$*" = 'compose ps --status running -q backend telegram-bot' &&
  ${TEST_APP_RUNNING:-false} = true ]]; then
  printf 'running-container\n'
fi
SH
chmod 0700 "$workspace/bin/docker" "$workspace/bin/rclone"
ln -s "$(command -v sha256sum)" "$workspace/bin/sha256sum"
export PATH="$workspace/bin:/usr/bin:/bin"
! command -v node >/dev/null 2>&1
export TEST_DOCKER_LOG="$workspace/docker.log"
export TEST_PRIVACY_DIRECTORY="$workspace/privacy"
export WCTM_BACKUP_CRYPTO_KEY_FILE="$workspace/key"
export RCLONE_CONFIG="$workspace/rclone.conf"
export WCTM_OFFSITE_DESTINATION="testremote:$workspace/remote"

scripts/ops/pilot-privacy.sh --credential-file "$workspace/database.conf" \
  --privacy-directory "$workspace/privacy" -- inspect \
  --tenant-id ten_fixture --store-id sto_fixture --base-url https://fixture.test \
  >"$workspace/inspect.log"
[[ $(wc -l <"$workspace/docker.log" | tr -d ' ') = 1 ]]

if scripts/ops/pilot-privacy.sh --credential-file "$workspace/database.conf" \
  --privacy-directory "$workspace/privacy" -- export \
  --tenant-id ten_fixture --store-id sto_fixture --base-url https://fixture.test \
  >"$workspace/export-refused.log" 2>&1; then
  echo >&2 'test failed: export without explicit delivery retention succeeded'
  exit 1
fi
scripts/ops/pilot-privacy.sh --credential-file "$workspace/database.conf" \
  --privacy-directory "$workspace/privacy" -- export \
  --tenant-id ten_fixture --store-id sto_fixture --base-url https://fixture.test \
  --retain-for-delivery >"$workspace/export.log"
export_path=$(sed -n 's/^privacy export retained for delivery: //p' "$workspace/export.log")
[[ -f "$export_path" && $(stat -c '%a' "$export_path" 2>/dev/null || stat -f '%Lp' "$export_path") = 600 ]]

scripts/ops/pilot-privacy.sh --credential-file "$workspace/database.conf" \
  --privacy-directory "$workspace/privacy" -- erase \
  --tenant-id ten_fixture --store-id sto_fixture --base-url https://fixture.test --execute \
  >"$workspace/erase.log"
grep -q 'pilot-data.cli.js prepare-erasure' "$workspace/docker.log"
grep -q 'pilot-data.cli.js erase' "$workspace/docker.log"
grep -q 'erasure archive: PASS' "$workspace/erase.log"
[[ $(find "$workspace/remote/privacy-erasure-ledger" -name '*.jsonl.enc' | wc -l | tr -d ' ') = 1 ]]
[[ ! -e "$export_path" ]]
! grep -q 'fixture-only' "$workspace"/*.log

unset WCTM_OFFSITE_DESTINATION
if scripts/ops/pilot-privacy.sh --credential-file "$workspace/database.conf" \
  --privacy-directory "$workspace/privacy" -- erase \
  --tenant-id ten_fixture --store-id sto_fixture --base-url https://fixture.test --execute \
  >"$workspace/missing.log" 2>&1; then
  echo >&2 'test failed: erasure proceeded without off-site ledger destination'
  exit 1
fi
[[ $(wc -l <"$workspace/docker.log" | tr -d ' ') = 7 ]]

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
echo 'pilot privacy wrapper: PASS no-host-node protected-config explicit export retention erase cleanup archive-before-erasure fail-closed'
