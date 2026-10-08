#!/usr/bin/env bash
set -euo pipefail
umask 077

workspace=$(mktemp -d)
trap 'rm -rf -- "$workspace"' EXIT HUP INT TERM
mkdir "$workspace/bin"
cat >"$workspace/bin/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$TEST_DOCKER_LOG"
case "${1:-} ${2:-}" in
  'ps --no-trunc')
    printf '%064d\n' 1
    [[ ${TEST_AMBIGUOUS:-false} != true ]] || printf '%064d\n' 2
    ;;
  'inspect --format')
    printf 'sha256:%064d\n' 3
    ;;
  'image inspect')
    if [[ ${TEST_WRONG_IMAGE:-false} = true ]]; then
      printf 'sha256:%064d\n' 4
    else
      printf 'sha256:%064d\n' 3
    fi
    ;;
  'run --rm')
    cat >/dev/null
    [[ ${TEST_RUN_FAILURE:-false} != true ]]
    ;;
  *) exit 1 ;;
esac
SH
chmod 0700 "$workspace/bin/docker"
export TEST_DOCKER_LOG="$workspace/docker.log"
export WCTM_COMPOSE_PROJECT=wctm_fixture
export WCTM_RETENTION_DATABASE=wctm_fixture
export WCTM_RETENTION_PGPASS_FILE="$workspace/retention.pgpass"
secret='fixture-password-never-log'
printf '127.0.0.1:5432:wctm_fixture:wctm_retention:%s\n' "$secret" >"$WCTM_RETENTION_PGPASS_FILE"
chmod 0600 "$WCTM_RETENTION_PGPASS_FILE"
rg_command=$(command -v rg)
PATH="$workspace/bin:/usr/bin:/bin"
export PATH
! command -v node >/dev/null 2>&1

scripts/ops/postgres-retention.sh >"$workspace/pass.log" 2>&1
grep -qx 'postgres retention: PASS' <(tail -n 1 "$workspace/pass.log")
grep -q -- '--pull=never --network container:' "$TEST_DOCKER_LOG"
grep -q -- '--read-only --cap-drop=ALL --security-opt=no-new-privileges' "$TEST_DOCKER_LOG"
grep -q -- '--env PGPASSFILE=/run/retention.pgpass' "$TEST_DOCKER_LOG"
! grep -q "$secret" "$TEST_DOCKER_LOG" "$workspace/pass.log"

expect_failure() {
  if scripts/ops/postgres-retention.sh >"$workspace/fail.log" 2>&1; then
    echo >&2 'test failed: retention operation did not fail closed'
    exit 1
  fi
  ! grep -q "$secret" "$workspace/fail.log"
}
unset WCTM_RETENTION_PGPASS_FILE
expect_failure
export WCTM_RETENTION_PGPASS_FILE="$workspace/retention.pgpass"
chmod 0644 "$WCTM_RETENTION_PGPASS_FILE"
expect_failure
chmod 0600 "$WCTM_RETENTION_PGPASS_FILE"
printf '127.0.0.1:5432:wctm_fixture:postgres:%s\n' "$secret" >"$WCTM_RETENTION_PGPASS_FILE"
expect_failure
printf '127.0.0.1:5432:wctm_fixture:wctm_retention:%s\n' "$secret" >"$WCTM_RETENTION_PGPASS_FILE"
TEST_AMBIGUOUS=true expect_failure
TEST_WRONG_IMAGE=true expect_failure
TEST_RUN_FAILURE=true expect_failure

# Only seven fixed mutations and their reviewed tables are accepted by this path.
[[ $("$rg_command" -c '^    (DELETE FROM|UPDATE) public\.' scripts/ops/postgres-retention.sql) = 7 ]]
! "$rg_command" -q 'EXECUTE|format\(|\\copy|\\i ' scripts/ops/postgres-retention.sql
"$rg_command" -q '^User=wctm$' ops/systemd/wctm-postgres-retention.service
"$rg_command" -q '^Type=oneshot$' ops/systemd/wctm-postgres-retention.service
"$rg_command" -q '^ProtectSystem=strict$' ops/systemd/wctm-postgres-retention.service
"$rg_command" -q '^Persistent=true$' ops/systemd/wctm-postgres-retention.timer
echo 'postgres retention shell: PASS no-host-node fail-closed reviewed-image read-only secret-safe fixed-allowlist systemd'
