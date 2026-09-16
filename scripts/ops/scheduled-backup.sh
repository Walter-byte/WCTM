#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${WCTM_BACKUP_DIRECTORY:?WCTM_BACKUP_DIRECTORY is required}"
retention_count=${WCTM_BACKUP_RETENTION_COUNT:-14}
result_file=$(mktemp)
trap 'rm -f -- "$result_file"' EXIT HUP INT TERM

WCTM_BACKUP_RESULT_FILE=$result_file scripts/ops/backup-postgres.sh --destination "$WCTM_BACKUP_DIRECTORY"
backup=$(cat "$result_file")

if [[ -n "${WCTM_OFFSITE_DESTINATION:-}" ]]; then
  scripts/ops/offsite-rclone.sh "$backup" "$backup.sha256" "$backup.json" "$WCTM_OFFSITE_DESTINATION"
fi

scripts/ops/backup-retention.sh --directory "$WCTM_BACKUP_DIRECTORY" --keep "$retention_count" --apply
echo 'scheduled backup: PASS'
