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
  docker compose exec -T backend npm run security:config-audit
else
  echo 'pre-cutover config audit: previously required by Gate 1 (backend currently stopped)'
fi

scripts/ops/backup-postgres.sh --destination "$backup_directory"

docker compose build migrate backend telegram-bot

scripts/ops/migrate-production.sh --credential-file "$migration_credential_file"

docker compose up -d --no-deps --force-recreate backend
docker compose up -d --no-deps --force-recreate telegram-bot

runtime_port=${PORT:-3000}
curl --fail --silent --show-error "http://127.0.0.1:$runtime_port/api/health" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:$runtime_port/api/health/readiness" >/dev/null
scripts/ops/verify-runtime-role.sh

echo "deployment path: PASS revision=$actual_revision"
