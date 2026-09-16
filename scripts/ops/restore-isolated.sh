#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  echo >&2 'usage: restore-isolated.sh --backup FILE [--critical-table TABLE ...] [--keep-on-failure]'
  exit 64
}

backup=''
keep_on_failure=false
critical_tables=()
while (($#)); do
  case "$1" in
    --backup) (($# >= 2)) || usage; backup=$2; shift 2 ;;
    --critical-table) (($# >= 2)) || usage; critical_tables+=("$2"); shift 2 ;;
    --keep-on-failure) keep_on_failure=true; shift ;;
    *) usage ;;
  esac
done

[[ -f "$backup" && -s "$backup" ]] || {
  echo >&2 'restore refused: explicit non-empty backup file is required'
  exit 64
}
[[ -f "$backup.sha256" && -f "$backup.json" ]] || {
  echo >&2 'restore refused: checksum and metadata sidecars are required'
  exit 65
}
for table in "${critical_tables[@]}"; do
  [[ "$table" =~ ^[a-z_][a-z0-9_]*$ ]] || {
    echo >&2 'restore refused: critical table names must be lowercase SQL identifiers'
    exit 64
  }
done

backup=$(cd "$(dirname "$backup")" && pwd -P)/$(basename "$backup")
(cd "$(dirname "$backup")" && sha256sum --check --status "$(basename "$backup.sha256")") || {
  echo >&2 'restore refused: checksum verification failed'
  exit 1
}

image='postgres:16.15-alpine3.24@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
suffix="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
container="wctm-restore-test-$suffix"
volume="wctm_restore_test_$suffix"
database='wctm_isolated_restore'
password="restore-test-$suffix"
completed=false

cleanup() {
  status=$?
  if $completed || ! $keep_on_failure; then
    docker rm --force "$container" >/dev/null 2>&1 || true
    case "$volume" in
      wctm_restore_test_*) docker volume rm "$volume" >/dev/null 2>&1 || true ;;
    esac
  else
    echo >&2 "isolated restore resources retained for diagnosis: container=$container volume=$volume"
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

docker volume create "$volume" >/dev/null
docker run -d --name "$container" --network none \
  --mount "type=volume,source=$volume,destination=/var/lib/postgresql/data" \
  -e POSTGRES_DB="$database" -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$password" \
  "$image" >/dev/null

stable_ready=0
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres -d "$database" >/dev/null 2>&1; then
    stable_ready=$((stable_ready + 1))
    ((stable_ready >= 3)) && break
  else
    stable_ready=0
  fi
  sleep 1
done
((stable_ready >= 3)) || {
  echo >&2 'restore failed: isolated PostgreSQL did not become stably ready'
  exit 1
}
docker exec -i "$container" pg_restore --list <"$backup" >/dev/null
docker exec -i "$container" pg_restore -U postgres -d "$database" --exit-on-error --no-owner --no-privileges <"$backup"

expected_migrations=$(find backend/prisma/migrations -mindepth 2 -maxdepth 2 -name migration.sql | wc -l | tr -d ' ')
restored_migrations=$(docker exec "$container" psql -XAtq -v ON_ERROR_STOP=1 -U postgres -d "$database" -c 'select count(*) from public._prisma_migrations where finished_at is not null and rolled_back_at is null')
[[ "$restored_migrations" = "$expected_migrations" ]] || {
  echo >&2 'restore verification failed: migration count differs from repository state'
  exit 1
}

table_count=$(docker exec "$container" psql -XAtq -v ON_ERROR_STOP=1 -U postgres -d "$database" -c "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")
[[ "$table_count" =~ ^[1-9][0-9]*$ ]] || {
  echo >&2 'restore verification failed: public schema contains no base tables'
  exit 1
}

for table in "${critical_tables[@]}"; do
  exists=$(docker exec "$container" psql -XAtq -v ON_ERROR_STOP=1 -U postgres -d "$database" -c "select count(*) from information_schema.tables where table_schema='public' and table_name='$table'")
  [[ "$exists" = '1' ]] || {
    echo >&2 "restore verification failed: critical table is absent: $table"
    exit 1
  }
  count=$(docker exec "$container" psql -XAtq -v ON_ERROR_STOP=1 -U postgres -d "$database" -c "select count(*) from public.\"$table\"")
  echo "critical table: $table rows=$count"
done

completed=true
echo "isolated restore: PASS migrations=$restored_migrations public_tables=$table_count network=none"
