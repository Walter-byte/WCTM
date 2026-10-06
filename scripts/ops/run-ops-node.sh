#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo >&2 'containerized operations runtime failed; check the reviewed local image and protected mounts'
  exit 1
}

image_tag=wctm-privacy-ops:node24.20.0-alpine3.24-openssl3.5.9-r0
image_details=$(docker image inspect --format '{{.Id}} {{index .Config.Labels "org.wctm.runtime"}} {{.Config.User}}' "$image_tag" 2>/dev/null) || fail
read -r image runtime_label image_user <<<"$image_details"
[[ $image =~ ^sha256:[0-9a-f]{64}$ && $runtime_label = privacy-ops && $image_user = node ]] || fail
mounts=()
while (($#)); do
  case "$1" in
    --ro|--rw)
      [[ $# -ge 2 && $2 = /* && $2 != *:* && $2 != *,* && $2 != *$'\n'* && $2 != / ]] || fail
      path=$2
      [[ -f $path || -d $path ]] && [[ ! -L $path ]] || fail
      if [[ $1 = --ro ]]; then
        mounts+=(--mount "type=bind,source=$path,target=$path,readonly")
      else
        [[ -d $path ]] || fail
        mounts+=(--mount "type=bind,source=$path,target=$path")
      fi
      shift 2 ;;
    --)
      shift
      break ;;
    *) fail ;;
  esac
done
[[ $# -ge 1 ]] || fail
docker run --rm --interactive --pull=never --network=none --read-only \
  --user "$(id -u):$(id -g)" --cap-drop=ALL \
  --security-opt=no-new-privileges --pids-limit=64 \
  ${mounts[@]+"${mounts[@]}"} --entrypoint node "$image" "$@" || fail
