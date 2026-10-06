#!/usr/bin/env bash
set -euo pipefail

[[ ${1:-} = run && " $* " = *' --pull=never '* &&
  " $* " = *' --network=none '* && " $* " = *' --read-only '* ]] || exit 99
while (($#)); do
  case "$1" in
    run|--rm|--interactive|--pull=never|--network=none|--read-only|--cap-drop=ALL|--security-opt=no-new-privileges|--pids-limit=64)
      shift ;;
    --user|--mount)
      shift 2 ;;
    --entrypoint)
      [[ ${2:-} = node ]] || exit 99
      shift 2
      [[ ${1:-} =~ ^node:24\.20\.0-alpine3\.24@sha256:[0-9a-f]{64}$ ]] || exit 99
      shift
      exec "$TEST_NODE" "$@" ;;
    *) exit 99 ;;
  esac
done
exit 99
