#!/usr/bin/env bash
set -euo pipefail

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

for file in "$dump" "$checksum" "$metadata"; do
  name=$(basename "$file")
  rclone copyto -- "$file" "$destination/$name"
  local_size=$(wc -c <"$file" | tr -d ' ')
  remote_size=$(rclone size --json "$destination/$name" | sed -n 's/.*"bytes":\([0-9][0-9]*\).*/\1/p')
  [[ "$remote_size" = "$local_size" ]] || {
    echo >&2 "off-site copy failed: size verification failed for $name"
    exit 1
  }
done

echo "off-site copy: PASS files=3 destination-configured=true"
