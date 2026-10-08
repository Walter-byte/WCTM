#!/usr/bin/env bash
set -euo pipefail
umask 077

image='postgres:16.15-alpine3.24@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
workspace=$(mktemp -d)
project="wctm_retention_test_$$"
container="${project}_postgres"
secret='fixture-retention-password-do-not-log'
cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
  rm -rf -- "$workspace"
}
trap cleanup EXIT HUP INT TERM

docker run -d --name "$container" \
  --label "com.docker.compose.project=$project" \
  --label com.docker.compose.service=postgres \
  -e POSTGRES_DB=retention_test -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=fixture-owner-password "$image" >/dev/null
ready=false
for _ in {1..60}; do
  if docker exec "$container" pg_isready -U postgres -d retention_test >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ $ready = true ]]

docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d retention_test <<SQL
REVOKE TEMPORARY ON DATABASE retention_test FROM PUBLIC;
CREATE ROLE wctm_runtime LOGIN NOINHERIT;
CREATE ROLE wctm_retention LOGIN NOINHERIT PASSWORD '$secret';
CREATE TABLE public.telegram_link_tokens (id text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE TABLE public.stores (id text PRIMARY KEY, registration_token_hash text, registration_token_expires_at timestamptz);
CREATE TABLE public.telegram_callback_references (id text PRIMARY KEY, expires_at timestamptz NOT NULL, note_body_encrypted text, note_content_fingerprint text);
CREATE TABLE public.telegram_search_references (id text PRIMARY KEY, expires_at timestamptz NOT NULL, query_encrypted text);
CREATE TABLE public.webhook_events (id text PRIMARY KEY, status text NOT NULL, completed_at timestamptz, failed_at timestamptz, payload jsonb NOT NULL);
CREATE TABLE public.audit_logs (id text PRIMARY KEY, created_at timestamptz NOT NULL);
CREATE TABLE public._prisma_migrations (id text PRIMARY KEY);
CREATE TABLE public.unrelated (id text PRIMARY KEY);
GRANT USAGE ON SCHEMA public TO wctm_runtime;
GRANT SELECT, INSERT, UPDATE ON public.telegram_link_tokens, public.stores, public.telegram_callback_references, public.webhook_events TO wctm_runtime;
GRANT SELECT, INSERT ON public.telegram_search_references, public.audit_logs TO wctm_runtime;
INSERT INTO public.telegram_link_tokens VALUES ('old', now()-interval '2 days'), ('fresh', now()-interval '12 hours');
INSERT INTO public.stores VALUES ('old', 'hash', now()-interval '2 days'), ('fresh', 'hash', now()-interval '12 hours');
INSERT INTO public.telegram_callback_references VALUES ('old', now()-interval '2 days', 'cipher', 'hash'), ('fresh', now()-interval '12 hours', 'cipher', 'hash');
INSERT INTO public.telegram_search_references VALUES ('old', now()-interval '2 days', 'cipher'), ('fresh', now()-interval '12 hours', 'cipher');
INSERT INTO public.webhook_events VALUES
  ('completed-old', 'COMPLETED', now()-interval '31 days', null, '{"private":true}'),
  ('completed-fresh', 'COMPLETED', now()-interval '29 days', null, '{"private":true}'),
  ('failed-old', 'FAILED', null, now()-interval '91 days', '{"private":true}'),
  ('failed-fresh', 'FAILED', null, now()-interval '89 days', '{"private":true}'),
  ('queued-old', 'QUEUED', now()-interval '100 days', now()-interval '100 days', '{"private":true}');
INSERT INTO public.audit_logs VALUES ('old', now()-interval '366 days'), ('fresh', now()-interval '364 days');
INSERT INTO public.unrelated VALUES ('preserve');
INSERT INTO public._prisma_migrations VALUES ('preserve');
SQL
docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -v DBNAME=retention_test -U postgres -d retention_test \
  -f - <scripts/ops/postgres-retention-grants.sql
docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d retention_test \
  -f - <scripts/ops/verify-retention-role.sql >"$workspace/role.log"
grep -q 'retention role: PASS' "$workspace/role.log"

printf '127.0.0.1:5432:retention_test:wctm_retention:%s\n' "$secret" >"$workspace/retention.pgpass"
chmod 0600 "$workspace/retention.pgpass"
export WCTM_COMPOSE_PROJECT=$project
export WCTM_RETENTION_DATABASE=retention_test
export WCTM_RETENTION_PGPASS_FILE="$workspace/retention.pgpass"

# The normal role retains its append-only audit and no-DELETE boundary.
roles=$(docker exec "$container" psql -XAt -U postgres -d retention_test -c "
SELECT has_table_privilege('wctm_runtime','public.telegram_link_tokens','DELETE'),
  has_table_privilege('wctm_runtime','public.audit_logs','UPDATE'),
  has_table_privilege('wctm_runtime','public.audit_logs','DELETE'),
  has_table_privilege('wctm_runtime','public.telegram_search_references','UPDATE'),
  has_table_privilege('wctm_retention','public.unrelated','DELETE'),
  has_table_privilege('wctm_retention','public._prisma_migrations','UPDATE'),
  has_schema_privilege('wctm_retention','public','CREATE'),
  has_database_privilege('wctm_retention','retention_test','TEMP'),
  (SELECT count(*) FROM pg_class WHERE relowner='wctm_retention'::regrole),
  (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolinherit FROM pg_roles WHERE rolname='wctm_retention');")
[[ $roles = 'f|f|f|f|f|f|f|f|0|f' ]]

unset_path=$WCTM_RETENTION_PGPASS_FILE
unset WCTM_RETENTION_PGPASS_FILE
if scripts/ops/postgres-retention.sh >"$workspace/no-credential.log" 2>&1; then
  echo >&2 'test failed: retention accepted a missing credential'
  exit 1
fi
export WCTM_RETENTION_PGPASS_FILE=$unset_path

# A host Node binary is not part of this path.
mkdir "$workspace/bin"
ln -s "$(command -v docker)" "$workspace/bin/docker"
for tool in bash id stat wc tr; do ln -s "$(command -v "$tool")" "$workspace/bin/$tool"; done
PATH="$workspace/bin:/usr/bin:/bin" scripts/ops/postgres-retention.sh >"$workspace/sweep.log" 2>&1
scripts/ops/postgres-retention.sh >>"$workspace/sweep.log" 2>&1
[[ $(grep -c 'postgres retention: PASS' "$workspace/sweep.log") = 2 ]]
! grep -q "$secret" "$workspace"/*.log

result=$(docker exec "$container" psql -XAt -U postgres -d retention_test -c "
SELECT (SELECT string_agg(id,',' ORDER BY id) FROM public.telegram_link_tokens),
  (SELECT registration_token_hash IS NULL AND registration_token_expires_at IS NULL FROM public.stores WHERE id='old'),
  (SELECT registration_token_hash='hash' FROM public.stores WHERE id='fresh'),
  (SELECT note_body_encrypted IS NULL AND note_content_fingerprint IS NULL FROM public.telegram_callback_references WHERE id='old'),
  (SELECT note_body_encrypted='cipher' FROM public.telegram_callback_references WHERE id='fresh'),
  (SELECT query_encrypted IS NULL FROM public.telegram_search_references WHERE id='old'),
  (SELECT query_encrypted='cipher' FROM public.telegram_search_references WHERE id='fresh'),
  (SELECT payload='{}'::jsonb FROM public.webhook_events WHERE id='completed-old'),
  (SELECT payload <> '{}'::jsonb FROM public.webhook_events WHERE id='completed-fresh'),
  (SELECT payload='{}'::jsonb FROM public.webhook_events WHERE id='failed-old'),
  (SELECT payload <> '{}'::jsonb FROM public.webhook_events WHERE id='failed-fresh'),
  (SELECT payload <> '{}'::jsonb FROM public.webhook_events WHERE id='queued-old'),
  (SELECT string_agg(id,',' ORDER BY id) FROM public.audit_logs),
  (SELECT count(*) FROM public.unrelated),
  (SELECT count(*) FROM public._prisma_migrations);")
[[ $result = 'fresh|t|t|t|t|t|t|t|t|t|t|t|fresh|1|1' ]]

for statement in \
  'DELETE FROM public.unrelated' \
  'DELETE FROM public._prisma_migrations' \
  'UPDATE public.audit_logs SET created_at=now()' \
  'CREATE TABLE public.forbidden (id int)'; do
  if docker exec "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d retention_test \
    -c "SET ROLE wctm_retention; $statement" >"$workspace/denied.log" 2>&1; then
    echo >&2 'test failed: retention identity acquired a non-approved capability'
    exit 1
  fi
done
if docker exec "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d retention_test \
  -c 'SET ROLE wctm_runtime; DELETE FROM public.audit_logs' >"$workspace/runtime-denied.log" 2>&1; then
  echo >&2 'test failed: backend runtime role deleted audit history'
  exit 1
fi
! grep -q "$secret" "$workspace/denied.log"
echo 'postgres retention integration: PASS role-boundary seven-mutations cutoffs recent-records idempotency credential-fail-closed secret-safe'
