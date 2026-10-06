#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  echo >&2 'privacy export cleanup failed; inspect protected directory and operator configuration'
  exit 1
}

if [[ $# != 2 && $# != 4 ]] ||
  { [[ $1 = sweep && $# != 2 ]] || [[ $1 != sweep && $# != 4 ]]; }; then
  echo >&2 'usage: privacy-export-artifacts.sh new-path|purge DIRECTORY TENANT_ID STORE_ID | sweep DIRECTORY'
  exit 64
fi
mode=$1
directory=$2
[[ $mode = sweep || $mode = purge || $mode = new-path ]] || fail
[[ $directory = /* && $directory != / && /$directory/ != */../* &&
  -d $directory && ! -L $directory ]] || fail
directory_mode=$(stat -c '%a' "$directory" 2>/dev/null || stat -f '%Lp' "$directory") || fail
[[ $directory_mode = 700 ]] || fail
directory=$(cd "$directory" && pwd -P) || fail
ledger=$directory/erasure-ledger.jsonl
[[ -f $ledger && ! -L $ledger ]] || fail
ledger_mode=$(stat -c '%a' "$ledger" 2>/dev/null || stat -f '%Lp' "$ledger") || fail
[[ $ledger_mode = 600 ]] || fail

scope_hash() {
  [[ $1 =~ ^ten_[A-Za-z0-9_-]+$ && $2 =~ ^sto_[A-Za-z0-9_-]+$ ]] || fail
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s\0%s' "$1" "$2" | sha256sum | awk '{print $1}'
  else
    printf '%s\0%s' "$1" "$2" | shasum -a 256 | awk '{print $1}'
  fi
}

if [[ $mode = new-path ]]; then
  scope=$(scope_hash "$3" "$4") || fail
  timestamp=$(date -u '+%s%3N' 2>/dev/null) || timestamp=''
  [[ $timestamp =~ ^[0-9]{13}$ ]] || timestamp="$(date -u '+%s')000"
  nonce=$(openssl rand -hex 8) || fail
  printf '%s/wctm-privacy-export-%s-%s-%s.json\n' "$directory" "$scope" "$timestamp" "$nonce"
  exit 0
fi

selected_scope=''
[[ $mode != purge ]] || selected_scope=$(scope_hash "$3" "$4") || fail
now=$(date -u '+%s') || fail
removed=0
shopt -s nullglob
for path in "$directory"/wctm-privacy-export-*; do
  name=${path##*/}
  [[ $name =~ ^wctm-privacy-export-([0-9a-f]{64})-([0-9]{13})-([0-9a-f]{16})\.json$ ]] || continue
  [[ -z $selected_scope || ${BASH_REMATCH[1]} = "$selected_scope" ]] || continue
  [[ -f $path && ! -L $path ]] || fail
  file_mode=$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path") || fail
  [[ $file_mode = 600 ]] || fail
  if [[ $mode = sweep ]]; then
    oldest=$((${BASH_REMATCH[2]:0:10}))
    modified=$(stat -c '%Y' "$path" 2>/dev/null || stat -f '%m' "$path") || fail
    (( modified < oldest )) && oldest=$modified
    born=$(stat -c '%W' "$path" 2>/dev/null || stat -f '%B' "$path") || fail
    (( born > 0 && born < oldest )) && oldest=$born
    (( now - oldest >= 23 * 3600 )) || continue
  fi
  rm -f -- "$path" || fail
  removed=$((removed + 1))
done
printf 'privacy export cleanup: PASS removed=%s\n' "$removed"
