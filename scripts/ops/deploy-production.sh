#!/bin/sh
set -eu
umask 077

usage() {
  echo >&2 'usage: deploy-production.sh --revision GIT_SHA --migration-credential-file PATH --backup-directory PATH'
  exit 64
}

[ "$#" -eq 6 ] || usage
[ "$1" = '--revision' ] || usage
expected_revision=$2
[ "$3" = '--migration-credential-file' ] || usage
migration_credential_file=$4
[ "$5" = '--backup-directory' ] || usage
backup_directory=$6

case "$expected_revision" in
  *[!0-9a-fA-F]*|'')
    echo >&2 'deployment refused: revision must be a hexadecimal Git object ID'
    exit 64
    ;;
esac

actual_revision=$(git rev-parse HEAD)
[ "$actual_revision" = "$expected_revision" ] || {
  echo >&2 'deployment refused: checked-out revision does not match --revision'
  exit 1
}

[ -z "$(git status --porcelain)" ] || {
  echo >&2 'deployment refused: repository worktree is not clean'
  exit 1
}

git merge-base --is-ancestor "$expected_revision" origin/main || {
  echo >&2 'deployment refused: revision is not contained in synchronized origin/main'
  exit 1
}

docker compose config --quiet
[ -n "$(docker compose ps --status running -q postgres)" ] && [ -n "$(docker compose ps --status running -q redis)" ] || {
  echo >&2 'deployment refused: PostgreSQL and Redis must be running'
  exit 1
}
if [ -n "$(docker compose ps -q backend)" ]; then
  docker compose exec -T backend node dist/security/security-config-audit.cli.js
else
  echo 'pre-cutover config audit: previously required by Gate 1 (backend currently stopped)'
fi

scripts/ops/backup-postgres.sh --destination "$backup_directory"

docker compose build migrate backend telegram-bot

scripts/ops/migrate-production.sh --credential-file "$migration_credential_file"

docker compose up -d --no-deps --force-recreate backend
docker compose up -d --no-deps --force-recreate telegram-bot

runtime_port=${PORT:-3000}
attempt=1
max_attempts=12
retry_delay=1
while :; do
  if curl --fail --silent --connect-timeout 1 --max-time 2 "http://127.0.0.1:$runtime_port/api/health" >/dev/null 2>&1; then
    if curl --fail --silent --connect-timeout 1 --max-time 2 "http://127.0.0.1:$runtime_port/api/health/readiness" >/dev/null 2>&1; then
      break
    fi
    failed_check=readiness
  else
    failed_check=health
  fi

  if [ "$attempt" -ge "$max_attempts" ]; then
    echo >&2 "deployment failed: backend $failed_check did not pass after $max_attempts attempts"
    exit 1
  fi
  sleep "$retry_delay"
  attempt=$((attempt + 1))
  if [ "$retry_delay" -lt 5 ]; then
    retry_delay=$((retry_delay * 2))
    [ "$retry_delay" -le 5 ] || retry_delay=5
  fi
done
scripts/ops/verify-runtime-role.sh

echo "deployment path: PASS revision=$actual_revision"
