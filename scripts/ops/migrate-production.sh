#!/bin/sh
set -eu
umask 077

usage() {
  echo >&2 'usage: migrate-production.sh --credential-file PATH'
  exit 64
}

[ "$#" -eq 2 ] || usage
[ "$1" = '--credential-file' ] || usage
credential_file=$2

[ -f "$credential_file" ] || {
  echo >&2 'migration refused: credential file does not exist'
  exit 66
}

file_mode=$(stat -c '%a' "$credential_file" 2>/dev/null || stat -f '%Lp' "$credential_file")
case "$file_mode" in
  600|400) ;;
  *)
    echo >&2 'migration refused: credential file mode must be 0600 or 0400'
    exit 65
    ;;
esac

database_url=''
line_count=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|'#'*) continue ;;
    DATABASE_URL=*)
      line_count=$((line_count + 1))
      database_url=${line#DATABASE_URL=}
      ;;
    *)
      echo >&2 'migration refused: credential file may contain only DATABASE_URL and comments'
      exit 65
      ;;
  esac
done < "$credential_file"

[ "$line_count" -eq 1 ] && [ -n "$database_url" ] || {
  echo >&2 'migration refused: credential file must contain exactly one non-empty DATABASE_URL'
  exit 65
}

cleanup() {
  database_url=''
  unset database_url
  docker compose --profile operations rm --force --stop migrate >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

echo 'starting explicit Prisma migration operation'
DATABASE_URL="$database_url" WCTM_MIGRATION_OPERATION=P7_2_EXPLICIT_MIGRATION \
  docker compose --profile operations run --rm --no-deps \
  -e DATABASE_URL -e WCTM_MIGRATION_OPERATION migrate
echo 'migration operation: PASS'
