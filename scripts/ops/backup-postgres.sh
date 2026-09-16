#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  echo >&2 'usage: backup-postgres.sh --destination DIRECTORY [--offsite-hook EXECUTABLE --offsite-destination DESTINATION]'
  exit 64
}

destination=''
offsite_hook=''
offsite_destination=''
while (($#)); do
  case "$1" in
    --destination)
      (($# >= 2)) || usage
      destination=$2
      shift 2
      ;;
    --offsite-hook)
      (($# >= 2)) || usage
      offsite_hook=$2
      shift 2
      ;;
    --offsite-destination)
      (($# >= 2)) || usage
      offsite_destination=$2
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ -n "$destination" && "$destination" != '/' ]] || {
  echo >&2 'backup refused: destination must be an explicit non-root directory'
  exit 64
}
if [[ -n "$offsite_hook" || -n "$offsite_destination" ]]; then
  [[ -n "$offsite_hook" && -x "$offsite_hook" && -n "$offsite_destination" ]] || {
    echo >&2 'backup refused: off-site hook and destination must be supplied together'
    exit 64
  }
fi

mkdir -p -- "$destination"
chmod 0700 "$destination"
destination=$(cd "$destination" && pwd -P)

container_id=${WCTM_POSTGRES_CONTAINER:-$(docker compose ps -q postgres)}
[[ -n "$container_id" ]] || {
  echo >&2 'backup failed: PostgreSQL container is not running'
  exit 1
}

database_name=$(docker exec "$container_id" sh -c 'exec psql -XAtq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select current_database()"')
[[ "$database_name" =~ ^[A-Za-z0-9_.-]+$ ]] || {
  echo >&2 'backup failed: database name is not safe for metadata'
  exit 1
}

created_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
revision=$(git rev-parse HEAD 2>/dev/null || printf 'unknown')
revision_short=${revision:0:12}
base="wctm-postgres-${timestamp}-${revision_short}"
dump_path="$destination/$base.dump"
checksum_path="$dump_path.sha256"
metadata_path="$dump_path.json"

[[ ! -e "$dump_path" && ! -e "$checksum_path" && ! -e "$metadata_path" ]] || {
  echo >&2 'backup failed: timestamped destination already exists'
  exit 1
}

partial_dump=$(mktemp "$destination/.${base}.dump.partial.XXXXXX")
partial_checksum=$(mktemp "$destination/.${base}.sha256.partial.XXXXXX")
partial_metadata=$(mktemp "$destination/.${base}.json.partial.XXXXXX")
cleanup() {
  rm -f -- "$partial_dump" "$partial_checksum" "$partial_metadata"
}
trap cleanup EXIT HUP INT TERM

docker exec "$container_id" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges' >"$partial_dump"
[[ -s "$partial_dump" ]] || {
  echo >&2 'backup failed: pg_dump produced an empty file'
  exit 1
}
docker exec -i "$container_id" pg_restore --list <"$partial_dump" >/dev/null

checksum=$(sha256sum "$partial_dump" | awk '{print $1}')
[[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || {
  echo >&2 'backup failed: invalid SHA-256 result'
  exit 1
}
size_bytes=$(wc -c <"$partial_dump" | tr -d ' ')
migration_count=$(docker exec "$container_id" sh -c 'exec psql -XAtq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from public._prisma_migrations where finished_at is not null and rolled_back_at is null"')
[[ "$migration_count" =~ ^[0-9]+$ ]] || {
  echo >&2 'backup failed: migration count is unavailable'
  exit 1
}
server_version=$(docker exec "$container_id" sh -c 'exec psql -XAtq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "show server_version"')
tool_version=$(docker exec "$container_id" pg_dump --version | tr -d '\r\n')

printf '%s  %s\n' "$checksum" "$(basename "$dump_path")" >"$partial_checksum"
cat >"$partial_metadata" <<EOF
{
  "format": "postgresql-custom",
  "createdAtUtc": "$created_at",
  "database": "$database_name",
  "repositoryRevision": "$revision",
  "completedMigrationCount": $migration_count,
  "sha256": "$checksum",
  "sizeBytes": $size_bytes,
  "postgresServerVersion": "$server_version",
  "pgDumpVersion": "$tool_version"
}
EOF

chmod 0600 "$partial_dump" "$partial_checksum" "$partial_metadata"
mv -- "$partial_dump" "$dump_path"
mv -- "$partial_checksum" "$checksum_path"
mv -- "$partial_metadata" "$metadata_path"

if [[ -n "$offsite_hook" ]]; then
  "$offsite_hook" "$dump_path" "$checksum_path" "$metadata_path" "$offsite_destination"
fi

if [[ -n "${WCTM_BACKUP_RESULT_FILE:-}" ]]; then
  printf '%s\n' "$dump_path" >"$WCTM_BACKUP_RESULT_FILE"
  chmod 0600 "$WCTM_BACKUP_RESULT_FILE"
fi

echo "backup: PASS file=$(basename "$dump_path") size_bytes=$size_bytes migrations=$migration_count checksum=$checksum"
