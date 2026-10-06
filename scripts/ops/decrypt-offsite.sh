#!/usr/bin/env bash
set -euo pipefail
umask 077

if (($# != 3)); then
  echo >&2 'usage: decrypt-offsite.sh ENCRYPTED_DUMP METADATA OUTPUT_DIRECTORY'
  exit 64
fi
encrypted=$1
metadata=$2
directory=$3
key_file=${WCTM_BACKUP_CRYPTO_KEY_FILE:-}
[[ -f "$encrypted" && -f "$encrypted.sha256" && -f "$metadata" && -d "$directory" &&
  "$directory" != '/' && "$key_file" = /* && -f "$key_file" && -r "$key_file" ]] || {
  echo >&2 'off-site decrypt refused: encrypted set, protected key and explicit output directory are required'
  exit 66
}
command -v docker >/dev/null 2>&1 || {
  echo >&2 'off-site decrypt failed: local Docker runtime is unavailable'
  exit 69
}
encrypted=$(cd "$(dirname "$encrypted")" && pwd -P)/$(basename "$encrypted")
metadata=$(cd "$(dirname "$metadata")" && pwd -P)/$(basename "$metadata")
directory=$(cd "$directory" && pwd -P)
(cd "$(dirname "$encrypted")" && sha256sum --check --status "$(basename "$encrypted.sha256")") || {
  echo >&2 'off-site decrypt refused: encrypted content checksum mismatch'
  exit 1
}
encrypted_sha256=$(sha256sum "$encrypted" | awk '{print $1}')
key_id=$(sha256sum "$key_file" | awk '{print substr($1, 1, 16)}')
name=$(basename "$encrypted")
[[ "$name" = wctm-postgres-*.dump.enc && "$(basename "$metadata")" = "$name.json" ]] || {
  echo >&2 'off-site decrypt refused: backup set names do not match'
  exit 65
}
expected=$(scripts/ops/run-ops-node.sh --ro "$metadata" -- -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.format !== "postgresql-custom" || data.offsiteEncryption?.format !== "WCTMBACKUPAESG1" ||
    data.offsiteEncryption?.keyId !== process.argv[2] ||
    data.offsiteEncryption?.ciphertextSha256 !== process.argv[3] ||
    !/^[0-9a-f]{64}$/.test(data.sha256)) process.exit(1);
process.stdout.write(data.sha256);
' "$metadata" "$key_id" "$encrypted_sha256") || {
  echo >&2 'off-site decrypt refused: metadata is invalid'
  exit 65
}
dump="$directory/${name%.enc}"
[[ ! -e "$dump" && ! -e "$dump.sha256" && ! -e "$dump.json" ]] || {
  echo >&2 'off-site decrypt refused: output backup set already exists'
  exit 73
}
crypto_script=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/backup-crypto.mjs
scripts/ops/run-ops-node.sh --ro "$crypto_script" --ro "$key_file" \
  --ro "$encrypted" --rw "$directory" -- \
  "$crypto_script" decrypt "$key_file" "$encrypted" "$dump" || {
  echo >&2 'off-site decrypt failed: authentication failed'
  exit 1
}
actual=$(sha256sum "$dump" | awk '{print $1}')
if [[ "$actual" != "$expected" ]]; then
  rm -f -- "$dump"
  echo >&2 'off-site decrypt failed: plaintext checksum mismatch'
  exit 1
fi
printf '%s  %s\n' "$expected" "$(basename "$dump")" >"$dump.sha256"
cp -- "$metadata" "$dump.json"
chmod 0600 "$dump" "$dump.sha256" "$dump.json"
echo "off-site decrypt: PASS file=$(basename "$dump")"
