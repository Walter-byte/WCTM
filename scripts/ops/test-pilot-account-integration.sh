#!/usr/bin/env bash
set -euo pipefail
umask 077

image='postgres:16.15-alpine3.24@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
container="wctm-account-test-$$"
database="wctm_ppr2_account_test_$$"
workspace=$(mktemp -d)
cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
  rm -rf -- "$workspace"
}
trap cleanup EXIT HUP INT TERM

docker run -d --pull=never --name "$container" --network bridge \
  -p 127.0.0.1::5432 -e POSTGRES_DB="$database" -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=fixture-account-test "$image" >/dev/null
ready=false
for _ in {1..60}; do
  if docker exec "$container" pg_isready -U postgres -d "$database" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ $ready = true ]]
port=$(docker port "$container" 5432/tcp | sed -n 's/^127\.0\.0\.1:\([0-9][0-9]*\)$/\1/p')
[[ $port =~ ^[0-9]+$ ]]
url="postgresql://postgres:fixture-account-test@127.0.0.1:$port/$database"
if ! (cd backend && DATABASE_URL="$url" ../node_modules/.bin/prisma migrate deploy \
  --config prisma.config.ts) >"$workspace/migrate.log" 2>&1; then
  echo >&2 'pilot account integration: migration setup failed'
  exit 1
fi
[[ $(docker exec "$container" psql -XAt -U postgres -d "$database" \
  -c "select count(*) from public._prisma_migrations where finished_at is not null") = 16 ]]
PPR2_ACCOUNT_TEST_DATABASE_URL="$url" node backend/test/integration/pilot-account.integration.cjs \
  >"$workspace/account.log" 2>&1 || {
  echo >&2 'pilot account integration: account checks failed'
  sed 's/fixture-account-test/[redacted]/g' "$workspace/account.log" >&2
  exit 1
}
grep -q 'pilot account integration: PASS' "$workspace/account.log"
! grep -q 'fixture-account-test' "$workspace/migrate.log" "$workspace/account.log"
cat "$workspace/account.log"
