#!/usr/bin/env bash
set -euo pipefail
umask 077

if (($# != 4)); then
  echo >&2 'usage: offsite-rclone.sh DUMP CHECKSUM METADATA RCLONE_DESTINATION'
  exit 64
fi

dump=$1
checksum=$2
metadata=$3
destination=${4%/}

for file in "$dump" "$checksum" "$metadata"; do
  [[ -f "$file" ]] || {
    echo >&2 'off-site copy failed: backup set is incomplete'
    exit 66
  }
done
command -v rclone >/dev/null 2>&1 || {
  echo >&2 'off-site copy failed: rclone is unavailable'
  exit 69
}
command -v node >/dev/null 2>&1 || {
  echo >&2 'off-site copy failed: local Node runtime is unavailable for encryption'
  exit 69
}
key_file=${WCTM_BACKUP_CRYPTO_KEY_FILE:-}
[[ "$key_file" = /* && -f "$key_file" && -r "$key_file" ]] || {
  echo >&2 'off-site copy refused: protected backup encryption key file is required'
  exit 66
}

read -r expected_dump_sha256 expected_dump_name checksum_extra <"$checksum"
[[ "$expected_dump_sha256" =~ ^[0-9a-fA-F]{64}$ &&
  "$expected_dump_name" = "$(basename "$dump")" &&
  -z "${checksum_extra:-}" ]] || {
  echo >&2 'off-site copy failed: local checksum record is invalid'
  exit 65
}
expected_dump_sha256=$(printf '%s' "$expected_dump_sha256" | tr 'A-F' 'a-f')
local_dump_sha256=$(sha256sum "$dump" | awk '{print $1}')
[[ "$local_dump_sha256" = "$expected_dump_sha256" ]] || {
  echo >&2 'off-site copy failed: local dump checksum verification failed'
  exit 1
}

crypto_script=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/backup-crypto.mjs
temporary_dir=$(mktemp -d "$(dirname "$dump")/.wctm-offsite.XXXXXXXX")
trap 'rm -rf -- "$temporary_dir"' EXIT HUP INT TERM
encrypted="$temporary_dir/$(basename "$dump").enc"
node "$crypto_script" encrypt "$key_file" "$dump" "$encrypted" || {
  echo >&2 'off-site copy failed: local backup encryption failed'
  exit 1
}
encrypted_checksum="$encrypted.sha256"
encrypted_sha256=$(sha256sum "$encrypted" | awk '{print $1}')
printf '%s  %s\n' "$encrypted_sha256" "$(basename "$encrypted")" >"$encrypted_checksum"
encrypted_metadata="$encrypted.json"
key_id=$(sha256sum "$key_file" | awk '{print substr($1, 1, 16)}')
node -e '
const fs = require("node:fs");
const [source, target, keyId, ciphertextSha256] = process.argv.slice(1);
const record = JSON.parse(fs.readFileSync(source, "utf8"));
if (record.format !== "postgresql-custom" || !/^[0-9a-f]{64}$/.test(record.sha256)) process.exit(1);
record.offsiteEncryption = { format: "WCTMBACKUPAESG1", keyId, ciphertextSha256 };
fs.writeFileSync(target, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
' "$metadata" "$encrypted_metadata" "$key_id" "$encrypted_sha256" || {
  echo >&2 'off-site copy failed: encrypted metadata preparation failed'
  exit 1
}

for file in "$encrypted" "$encrypted_checksum" "$encrypted_metadata"; do
  name=$(basename "$file")
  rclone copyto -- "$file" "$destination/$name"
  local_size=$(wc -c <"$file" | tr -d ' ')
  remote_size=$(rclone size --json "$destination/$name" | sed -n 's/.*"bytes":\([0-9][0-9]*\).*/\1/p')
  [[ "$remote_size" =~ ^[0-9]+$ && "$remote_size" = "$local_size" ]] || {
    echo >&2 "off-site copy failed: size verification failed for $name"
    exit 1
  }
done

remote_dump="$destination/$(basename "$encrypted")"
remote_dump_sha256=''
verification_method=''
if native_hash_output=$(rclone hashsum sha256 "$remote_dump" 2>/dev/null); then
  native_hash=$(printf '%s\n' "$native_hash_output" | awk 'NR == 1 { print tolower($1) }')
  if [[ "$native_hash" =~ ^[0-9a-f]{64}$ ]]; then
    remote_dump_sha256=$native_hash
    verification_method='native-sha256'
  fi
fi

if [[ -z "$remote_dump_sha256" ]]; then
  if ! remote_dump_sha256=$(rclone cat "$remote_dump" | sha256sum | awk '{print $1}'); then
    echo >&2 'off-site copy failed: remote content verification is unavailable'
    exit 1
  fi
  [[ "$remote_dump_sha256" =~ ^[0-9a-f]{64}$ ]] || {
    echo >&2 'off-site copy failed: remote content verification is invalid'
    exit 1
  }
  verification_method='streamed-sha256'
fi

[[ "$remote_dump_sha256" = "$encrypted_sha256" ]] || {
  echo >&2 'off-site copy failed: remote encrypted dump SHA-256 mismatch'
  exit 1
}

echo "off-site copy: PASS files=3 content_sha256=verified method=$verification_method destination-configured=true"
