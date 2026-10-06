#!/usr/bin/env bash
set -euo pipefail

workspace=$(mktemp -d)
trap 'rm -rf -- "$workspace"' EXIT HUP INT TERM
export TEST_NODE=$(command -v node)
mkdir "$workspace/bin" "$workspace/remote"
cp scripts/ops/test-fixtures/rclone "$workspace/bin/rclone"
cp scripts/ops/test-fixtures/docker-node-run.sh "$workspace/bin/docker"
chmod 0700 "$workspace/bin/rclone" "$workspace/bin/docker"
export PATH="$workspace/bin:/usr/bin:/bin"
! command -v node >/dev/null 2>&1

stamp() {
  "$TEST_NODE" -e 'process.stdout.write(new Date(Date.now() - Number(process.argv[1]) * 86400000).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z")' "$1"
}
create_set() {
  base="wctm-postgres-$(stamp "$1")-deadbeef0000"
  : >"$workspace/remote/$base.dump.enc"
  : >"$workspace/remote/$base.dump.enc.sha256"
  : >"$workspace/remote/$base.dump.enc.json"
}
create_set 0
create_set 1
create_set 40
create_set 50
legacy="wctm-postgres-$(stamp 70)-deadbeef0000.dump"
: >"$workspace/remote/$legacy"
incomplete="wctm-postgres-$(stamp 80)-deadbeef0000.dump.enc"
: >"$workspace/remote/$incomplete"

scripts/ops/offsite-retention.sh "testremote:$workspace/remote" 30 >"$workspace/result.log"
[[ $(find "$workspace/remote" -maxdepth 1 -name '*.dump.enc' | wc -l | tr -d ' ') = 3 ]]
[[ -f "$workspace/remote/$legacy" && -f "$workspace/remote/$incomplete" ]]
[[ $(find "$workspace/remote" -maxdepth 1 -name '*.dump.enc.sha256' | wc -l | tr -d ' ') = 2 ]]
grep -q 'removed_artifacts=6 legacy_plaintext_untouched=true' "$workspace/result.log"
echo 'off-site retention: PASS no-host-node 30-day policy newest-two protected incomplete/legacy preserved'
