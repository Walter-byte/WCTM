#!/usr/bin/env bash
set -euo pipefail

if (($# != 2)); then
  echo >&2 'usage: offsite-retention.sh RCLONE_DESTINATION MAX_AGE_DAYS'
  exit 64
fi
destination=${1%/}
days=$2
[[ "$days" =~ ^[0-9]+$ ]] && ((days >= 1)) || {
  echo >&2 'off-site retention refused: max age must be positive whole days'
  exit 64
}
command -v rclone >/dev/null 2>&1 && command -v docker >/dev/null 2>&1 || {
  echo >&2 'off-site retention failed: required local tool is unavailable'
  exit 69
}
selector=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/select-offsite-expired.mjs
listing=$(rclone lsf --files-only "$destination") || {
  echo >&2 'off-site retention failed: remote listing unavailable'
  exit 1
}
selected=$(printf '%s\n' "$listing" | scripts/ops/run-ops-node.sh --ro "$selector" -- "$selector" "$days") || {
  echo >&2 'off-site retention failed: selection unavailable'
  exit 1
}
removed=0
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  rclone deletefile "$destination/$name" || {
    echo >&2 'off-site retention failed: selected artifact removal failed'
    exit 1
  }
  removed=$((removed + 1))
done <<<"$selected"
echo "off-site retention: PASS max_age_days=$days removed_artifacts=$removed legacy_plaintext_untouched=true"
