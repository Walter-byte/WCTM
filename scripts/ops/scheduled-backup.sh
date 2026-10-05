#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${WCTM_BACKUP_DIRECTORY:?WCTM_BACKUP_DIRECTORY is required}"
retention_count=${WCTM_BACKUP_RETENTION_COUNT:-14}
compose_project=${WCTM_COMPOSE_PROJECT:-}
[[ "$compose_project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || {
  echo >&2 'scheduled backup refused: WCTM_COMPOSE_PROJECT must name the reviewed Compose project'
  exit 64
}
if [[ -n "${WCTM_OFFSITE_DESTINATION:-}" ]]; then
  rclone_config=${RCLONE_CONFIG:-}
  [[ "$rclone_config" = /* && -f "$rclone_config" && -r "$rclone_config" ]] || {
    echo >&2 'scheduled backup refused: RCLONE_CONFIG must be an absolute path to a readable regular file for off-site copy'
    exit 66
  }
  export RCLONE_CONFIG=$rclone_config
fi
container_id=$(docker ps --no-trunc \
  --filter "label=com.docker.compose.project=$compose_project" \
  --filter 'label=com.docker.compose.service=postgres' \
  --format '{{.ID}}') || {
  echo >&2 'scheduled backup failed: PostgreSQL container discovery failed'
  exit 1
}
[[ "$container_id" =~ ^[0-9a-f]{64}$ ]] || {
  echo >&2 'scheduled backup refused: expected exactly one running PostgreSQL container for the reviewed Compose project'
  exit 1
}
export WCTM_POSTGRES_CONTAINER=$container_id
result_file=$(mktemp)
trap 'rm -f -- "$result_file"' EXIT HUP INT TERM

WCTM_BACKUP_RESULT_FILE=$result_file scripts/ops/backup-postgres.sh --destination "$WCTM_BACKUP_DIRECTORY"
backup=$(cat "$result_file")

if [[ -n "${WCTM_OFFSITE_DESTINATION:-}" ]]; then
  scripts/ops/offsite-rclone.sh "$backup" "$backup.sha256" "$backup.json" "$WCTM_OFFSITE_DESTINATION"
fi

scripts/ops/backup-retention.sh --directory "$WCTM_BACKUP_DIRECTORY" --keep "$retention_count" --apply
echo 'scheduled backup: PASS'
