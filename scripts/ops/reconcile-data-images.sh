#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo >&2 'usage: reconcile-data-images.sh --backup FILE --postgres-volume NAME --redis-volume NAME'
  exit 64
}

backup=''
expected_postgres_volume=''
expected_redis_volume=''
while (($#)); do
  case "$1" in
    --backup) (($# >= 2)) || usage; backup=$2; shift 2 ;;
    --postgres-volume) (($# >= 2)) || usage; expected_postgres_volume=$2; shift 2 ;;
    --redis-volume) (($# >= 2)) || usage; expected_redis_volume=$2; shift 2 ;;
    *) usage ;;
  esac
done

[[ -f "$backup" && -f "$backup.sha256" && -f "$backup.json" ]] || {
  echo >&2 'reconciliation refused: complete verified backup set is required'
  exit 65
}
(cd "$(dirname "$backup")" && sha256sum --check --status "$(basename "$backup.sha256")") || {
  echo >&2 'reconciliation refused: backup checksum failed'
  exit 1
}
for volume in "$expected_postgres_volume" "$expected_redis_volume"; do
  [[ "$volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]+$ ]] || {
    echo >&2 'reconciliation refused: explicit named volumes are required'
    exit 64
  }
done

postgres_container=$(docker compose ps -q postgres)
redis_container=$(docker compose ps -q redis)
[[ -n "$postgres_container" && -n "$redis_container" ]] || {
  echo >&2 'reconciliation refused: PostgreSQL and Redis must be running for preflight'
  exit 1
}

postgres_volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$postgres_container")
redis_volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$redis_container")
[[ "$postgres_volume" = "$expected_postgres_volume" && "$redis_volume" = "$expected_redis_volume" ]] || {
  echo >&2 'reconciliation refused: running named volumes do not match explicit expected values'
  exit 1
}

before_migrations=$(docker exec "$postgres_container" sh -c 'exec psql -XAtq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from public._prisma_migrations where finished_at is not null and rolled_back_at is null"')
before_redis_keys=$(docker exec "$redis_container" redis-cli --raw DBSIZE)

failure() {
  echo >&2 'data-image reconciliation stopped: keep both named volumes; inspect service logs and use the documented recovery path'
}
trap failure ERR

docker compose stop backend telegram-bot
docker compose pull postgres redis
docker compose up -d --no-deps --force-recreate postgres redis

for _ in $(seq 1 60); do
  docker compose exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1 && break
  sleep 1
done
docker compose exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null
[[ $(docker compose exec -T redis redis-cli --raw PING | tr -d '\r') = PONG ]]

postgres_container=$(docker compose ps -q postgres)
redis_container=$(docker compose ps -q redis)
[[ $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$postgres_container") = "$expected_postgres_volume" ]]
[[ $(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$redis_container") = "$expected_redis_volume" ]]

after_migrations=$(docker exec "$postgres_container" sh -c 'exec psql -XAtq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from public._prisma_migrations where finished_at is not null and rolled_back_at is null"')
after_redis_keys=$(docker exec "$redis_container" redis-cli --raw DBSIZE)
[[ "$after_migrations" = "$before_migrations" && "$after_redis_keys" = "$before_redis_keys" ]]

postgres_image=$(docker inspect --format '{{.Config.Image}}' "$postgres_container")
redis_image=$(docker inspect --format '{{.Config.Image}}' "$redis_container")
[[ "$postgres_image" = 'postgres:16.15-alpine3.24@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685' ]]
[[ "$redis_image" = 'redis:7.4.11-alpine3.21@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf' ]]

trap - ERR
echo "data-image reconciliation: PASS migrations=$after_migrations redis_keys=$after_redis_keys volumes_preserved=true applications_stopped=true"
