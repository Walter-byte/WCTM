#!/usr/bin/env bash
set -euo pipefail
umask 077

if (($# != 2)); then
  echo >&2 'usage: restore-erasure-ledger.sh ENCRYPTED_LEDGER OUTPUT_DIRECTORY'
  exit 64
fi
encrypted=$1
directory=$2
key_file=${WCTM_BACKUP_CRYPTO_KEY_FILE:-}
[[ -f "$encrypted" && -f "$encrypted.sha256" && -f "$encrypted.json" &&
  -d "$directory" && "$directory" != '/' && "$key_file" = /* &&
  -f "$key_file" && -r "$key_file" ]] || {
  echo >&2 'erasure ledger restore refused: complete encrypted set, key and output directory are required'
  exit 66
}
name=$(basename "$encrypted")
[[ "$name" =~ ^erasure-ledger-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}\.jsonl\.enc$ ]] || {
  echo >&2 'erasure ledger restore refused: encrypted set name is invalid'
  exit 65
}
encrypted=$(cd "$(dirname "$encrypted")" && pwd -P)/$name
directory=$(cd "$directory" && pwd -P)
(cd "$(dirname "$encrypted")" && sha256sum --check --status "$name.sha256") || {
  echo >&2 'erasure ledger restore refused: encrypted checksum mismatch'
  exit 1
}
key_id=$(sha256sum "$key_file" | awk '{print substr($1, 1, 16)}')
cipher_sha256=$(sha256sum "$encrypted" | awk '{print $1}')
expected_plaintext=$(scripts/ops/run-ops-node.sh --ro "$encrypted.json" -- -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (value.format !== "WCTMBACKUPAESG1" || value.keyId !== process.argv[2] ||
    value.ciphertextSha256 !== process.argv[3] ||
    !/^[0-9a-f]{64}$/.test(value.ledgerSha256)) process.exit(1);
process.stdout.write(value.ledgerSha256);
' "$encrypted.json" "$key_id" "$cipher_sha256") || {
  echo >&2 'erasure ledger restore refused: metadata or recovery key mismatch'
  exit 1
}
output="$directory/erasure-ledger.jsonl"
[[ ! -e "$output" ]] || {
  echo >&2 'erasure ledger restore refused: output ledger already exists'
  exit 73
}
crypto_script=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/backup-crypto.mjs
scripts/ops/run-ops-node.sh --ro "$crypto_script" --ro "$key_file" \
  --ro "$encrypted" --rw "$directory" -- \
  "$crypto_script" decrypt "$key_file" "$encrypted" "$output" || {
  echo >&2 'erasure ledger restore failed: authentication failed'
  exit 1
}
actual=$(sha256sum "$output" | awk '{print $1}')
if [[ "$actual" != "$expected_plaintext" ]]; then
  rm -f -- "$output"
  echo >&2 'erasure ledger restore failed: plaintext checksum mismatch'
  exit 1
fi
chmod 0600 "$output"
echo 'erasure ledger restore: PASS authenticated=true'
