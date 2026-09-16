#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo >&2 'usage: backup-retention.sh --directory DIRECTORY [--keep 14] [--apply]'
  exit 64
}

directory=''
keep=14
apply=false
while (($#)); do
  case "$1" in
    --directory) (($# >= 2)) || usage; directory=$2; shift 2 ;;
    --keep) (($# >= 2)) || usage; keep=$2; shift 2 ;;
    --apply) apply=true; shift ;;
    *) usage ;;
  esac
done

[[ -d "$directory" && "$directory" != '/' ]] || {
  echo >&2 'retention refused: directory must be an existing non-root directory'
  exit 64
}
[[ "$keep" =~ ^[0-9]+$ ]] && ((keep >= 1)) || {
  echo >&2 'retention refused: --keep must be at least 1'
  exit 64
}

directory=$(cd "$directory" && pwd -P)
valid=()
while IFS= read -r dump; do
  [[ -f "$dump.sha256" && -f "$dump.json" ]] || continue
  if (cd "$directory" && sha256sum --check --status "$(basename "$dump.sha256")"); then
    valid+=("$dump")
  fi
done < <(find "$directory" -maxdepth 1 -type f -name 'wctm-postgres-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z-*.dump' -print | LC_ALL=C sort -r)

deleted=0
for ((index=keep; index<${#valid[@]}; index++)); do
  dump=${valid[$index]}
  if $apply; then
    rm -- "$dump" "$dump.sha256" "$dump.json"
  else
    echo "would remove backup set: $(basename "$dump")"
  fi
  deleted=$((deleted + 1))
done

mode=dry-run
$apply && mode=applied
echo "retention: PASS mode=$mode valid_sets=${#valid[@]} kept_at_least=$keep selected_for_removal=$deleted"
