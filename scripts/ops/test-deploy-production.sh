#!/usr/bin/env bash
set -euo pipefail

workspace=$(mktemp -d)
trap 'rm -rf -- "$workspace"' EXIT
mkdir -p "$workspace/scripts/ops" "$workspace/bin" "$workspace/state"
cp scripts/ops/deploy-production.sh "$workspace/scripts/ops/deploy-production.sh"

cat >"$workspace/bin/git" <<'SH'
#!/bin/sh
case "$*" in
  'rev-parse HEAD') printf '%s\n' "$TEST_REVISION" ;;
  'status --porcelain'|"merge-base --is-ancestor $TEST_REVISION origin/main") ;;
  *) exit 99 ;;
esac
SH

cat >"$workspace/bin/docker" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >>"$TEST_STATE/docker.log"
case "$*" in
  'compose config --quiet'|'compose build migrate backend telegram-bot'|\
    'compose up -d --no-deps --force-recreate backend'|\
    'compose up -d --no-deps --force-recreate telegram-bot'|\
    'compose exec -T backend node dist/security/security-config-audit.cli.js') ;;
  'compose ps --status running -q postgres'|'compose ps --status running -q redis'|\
    'compose ps -q backend') printf 'test-container-id\n' ;;
  *) exit 99 ;;
esac
SH

cat >"$workspace/bin/curl" <<'SH'
#!/bin/sh
count=$(cat "$TEST_STATE/curl-count")
count=$((count + 1))
printf '%s\n' "$count" >"$TEST_STATE/curl-count"
printf '%s\n' "$*" >>"$TEST_STATE/curl.log"
for arg do url=$arg; done
if [ "$TEST_CURL_MODE" = delayed ] && [ "$count" -eq 1 ]; then
  exit 56
fi
if [ "$TEST_CURL_MODE" = persistent ] && [ "${url##*/}" = readiness ]; then
  exit 22
fi
exit 0
SH

cat >"$workspace/bin/sleep" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >>"$TEST_STATE/sleep.log"
SH

for helper in backup-postgres migrate-production verify-runtime-role; do
  cat >"$workspace/scripts/ops/$helper.sh" <<'SH'
#!/bin/sh
printf '%s\n' "${0##*/}" >>"$TEST_STATE/operations.log"
SH
done
chmod +x "$workspace"/bin/* "$workspace"/scripts/ops/*.sh

revision=1234567890abcdef1234567890abcdef12345678
export TEST_REVISION=$revision TEST_STATE="$workspace/state"
export PATH="$workspace/bin:$PATH"

run_deploy() {
  (cd "$workspace" && sh scripts/ops/deploy-production.sh \
    --revision "$revision" \
    --migration-credential-file /unused/test-migration-file \
    --backup-directory /unused/test-backups)
}

printf '0\n' >"$TEST_STATE/curl-count"
export TEST_CURL_MODE=delayed
run_deploy >"$workspace/delayed.log" 2>&1
grep -q 'deployment path: PASS' "$workspace/delayed.log"
[[ $(cat "$TEST_STATE/curl-count") = 3 ]]
[[ $(cat "$TEST_STATE/sleep.log") = 1 ]]
grep -qx 'compose exec -T backend node dist/security/security-config-audit.cli.js' "$TEST_STATE/docker.log"
! grep -q 'compose exec -T backend npm ' "$TEST_STATE/docker.log"
grep -qx 'verify-runtime-role.sh' "$TEST_STATE/operations.log"

rm -f "$TEST_STATE"/*.log
printf '0\n' >"$TEST_STATE/curl-count"
export TEST_CURL_MODE=persistent
if run_deploy >"$workspace/persistent.log" 2>&1; then
  echo >&2 'test failed: persistent readiness failure was accepted'
  exit 1
fi
grep -q 'deployment failed: backend readiness did not pass after 12 attempts' "$workspace/persistent.log"
[[ $(cat "$TEST_STATE/curl-count") = 24 ]]
[[ $(wc -l <"$TEST_STATE/sleep.log" | tr -d ' ') = 11 ]]
[[ $(sed -n '1,4p' "$TEST_STATE/sleep.log" | tr '\n' ',') = '1,2,4,5,' ]]
! grep -q 'verify-runtime-role.sh' "$TEST_STATE/operations.log"

echo 'deployment script: PASS startup-reset-retry persistent-readiness-failure compiled-config-audit'
