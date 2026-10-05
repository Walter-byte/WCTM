#!/usr/bin/env bash
set -euo pipefail
umask 077

if (($# != 2)); then
  echo >&2 'usage: archive-erasure-ledger.sh LEDGER RCLONE_DESTINATION'
  exit 64
fi
ledger=$1
destination=${2%/}
key_file=${WCTM_BACKUP_CRYPTO_KEY_FILE:-}
[[ -f "$ledger" && -s "$ledger" && "$key_file" = /* && -f "$key_file" && -r "$key_file" &&
  -n "${RCLONE_CONFIG:-}" && -f "$RCLONE_CONFIG" && -r "$RCLONE_CONFIG" ]] || {
  echo >&2 'erasure archive refused: protected ledger, key and rclone configuration are required'
  exit 66
}
command -v node >/dev/null 2>&1 && command -v rclone >/dev/null 2>&1 || {
  echo >&2 'erasure archive failed: required local tool is unavailable'
  exit 69
}
temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT HUP INT TERM
timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
ledger_sha256=$(sha256sum "$ledger" | awk '{print $1}')
name="erasure-ledger-$timestamp-${ledger_sha256:0:12}.jsonl.enc"
encrypted="$temporary_dir/$name"
crypto_script=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/backup-crypto.mjs
node "$crypto_script" encrypt "$key_file" "$ledger" "$encrypted" || {
  echo >&2 'erasure archive failed: encryption failed'
  exit 1
}
cipher_sha256=$(sha256sum "$encrypted" | awk '{print $1}')
key_id=$(sha256sum "$key_file" | awk '{print substr($1, 1, 16)}')
printf '%s  %s\n' "$cipher_sha256" "$name" >"$encrypted.sha256"
printf '{"format":"WCTMBACKUPAESG1","keyId":"%s","ciphertextSha256":"%s","ledgerSha256":"%s"}\n' \
  "$key_id" "$cipher_sha256" "$ledger_sha256" >"$encrypted.json"

for file in "$encrypted" "$encrypted.sha256" "$encrypted.json"; do
  artifact=$(basename "$file")
  rclone copyto -- "$file" "$destination/$artifact"
  local_size=$(wc -c <"$file" | tr -d ' ')
  remote_size=$(rclone size --json "$destination/$artifact" | sed -n 's/.*"bytes":\([0-9][0-9]*\).*/\1/p')
  [[ "$remote_size" = "$local_size" ]] || {
    echo >&2 'erasure archive failed: remote size mismatch'
    exit 1
  }
done
remote="$destination/$name"
remote_sha256=''
if hash_output=$(rclone hashsum sha256 "$remote" 2>/dev/null); then
  remote_sha256=$(printf '%s\n' "$hash_output" | awk 'NR == 1 {print tolower($1)}')
fi
if [[ ! "$remote_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  remote_sha256=$(rclone cat "$remote" | sha256sum | awk '{print $1}')
fi
[[ "$remote_sha256" = "$cipher_sha256" ]] || {
  echo >&2 'erasure archive failed: remote content SHA-256 mismatch'
  exit 1
}
echo "erasure archive: PASS file=$name content_sha256=verified"
