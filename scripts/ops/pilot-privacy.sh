#!/usr/bin/env bash
set -euo pipefail
umask 077

if (($# < 6)) || [[ $1 != --credential-file || $3 != --privacy-directory || $5 != -- ]]; then
  echo >&2 'usage: pilot-privacy.sh --credential-file PATH --privacy-directory PATH -- MODE [exact target options]'
  exit 64
fi
credential_file=$2
privacy_directory=$4
shift 5
[[ "$credential_file" = /* && -f "$credential_file" && "$privacy_directory" = /* &&
  "$privacy_directory" != *:* &&
  -d "$privacy_directory" && "$privacy_directory" != '/' &&
  "$privacy_directory" != "$PWD" && "$privacy_directory" != "$PWD"/* ]] || {
  echo >&2 'privacy operation refused: protected credential and external privacy directory are required'
  exit 66
}
credential_mode=$(stat -c '%a' "$credential_file" 2>/dev/null || stat -f '%Lp' "$credential_file")
directory_mode=$(stat -c '%a' "$privacy_directory" 2>/dev/null || stat -f '%Lp' "$privacy_directory")
[[ "$credential_mode" = 600 || "$credential_mode" = 400 ]] &&
  [[ "$directory_mode" = 700 ]] || {
  echo >&2 'privacy operation refused: credential must be 0600/0400 and directory 0700'
  exit 65
}
database_url=''
count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    ''|'#'*) continue ;;
    DATABASE_URL=*) database_url=${line#DATABASE_URL=}; count=$((count + 1)) ;;
    *) echo >&2 'privacy operation refused: credential file format is invalid'; exit 65 ;;
  esac
done <"$credential_file"
[[ "$count" = 1 && -n "$database_url" ]] || {
  echo >&2 'privacy operation refused: exactly one protected database URL is required'
  exit 65
}

ledger="$privacy_directory/erasure-ledger.jsonl"
[[ -f "$ledger" ]] || {
  echo >&2 'privacy operation refused: protected erasure ledger is missing'
  exit 66
}
ledger_mode=$(stat -c '%a' "$ledger" 2>/dev/null || stat -f '%Lp' "$ledger")
[[ -f "$ledger" && "$ledger_mode" = 600 ]] || {
  echo >&2 'privacy operation refused: erasure ledger must be a 0600 regular file'
  exit 65
}

mode=$1
shift
case "$mode" in
  inspect|disconnect|export|erase|scrub|replay) ;;
  *) echo >&2 'privacy operation refused: invalid mode'; exit 64 ;;
esac

if [[ " $* " = *' --execute '* ]]; then
  case "$mode" in
    disconnect|scrub|erase|replay)
      running=$(docker compose ps --status running -q backend telegram-bot) || {
        echo >&2 'privacy operation refused: application quiescence could not be verified'
        exit 1
      }
      [[ -z "$running" ]] || {
        echo >&2 'privacy operation refused: stop backend and bot before execution'
        exit 1
      }
      ;;
  esac
fi

cleanup() {
  database_url=''
  unset database_url DATABASE_URL WCTM_PILOT_PRIVACY_OPERATION
}
trap cleanup EXIT HUP INT TERM
export DATABASE_URL=$database_url
export WCTM_PILOT_PRIVACY_OPERATION=operator-approved
run_privacy() {
  docker compose run --rm --no-deps \
    --volume "$privacy_directory:$privacy_directory:rw" \
    -e DATABASE_URL -e WCTM_PILOT_PRIVACY_OPERATION \
    --entrypoint node backend \
    dist/privacy/pilot-data.cli.js "$1" "${@:2}" --ledger "$ledger"
}

if [[ "$mode" = erase && " $* " = *' --execute '* ]]; then
  [[ -n "${WCTM_OFFSITE_DESTINATION:-}" ]] || {
    echo >&2 'privacy erasure refused: verified off-site ledger destination is required'
    exit 66
  }
  run_privacy prepare-erasure "$@"
  scripts/ops/archive-erasure-ledger.sh "$ledger" "${WCTM_OFFSITE_DESTINATION%/}/privacy-erasure-ledger"
  run_privacy erase "$@"
else
  run_privacy "$mode" "$@"
fi
