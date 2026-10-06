#!/usr/bin/env bash
set -euo pipefail
umask 077

workspace=$(mktemp -d)
trap 'rm -rf -- "$workspace"' EXIT HUP INT TERM
openssl rand 32 >"$workspace/key"
openssl rand 32 >"$workspace/other-key"
printf 'PGDMP synthetic customer marker\n' >"$workspace/source.dump"
node scripts/ops/backup-crypto.mjs encrypt "$workspace/key" \
  "$workspace/source.dump" "$workspace/source.dump.enc"
[[ ! -e "$workspace/remote.dump" ]]
! grep -aq 'synthetic customer marker' "$workspace/source.dump.enc"
node scripts/ops/backup-crypto.mjs decrypt "$workspace/key" \
  "$workspace/source.dump.enc" "$workspace/restored.dump"
cmp "$workspace/source.dump" "$workspace/restored.dump"

if node scripts/ops/backup-crypto.mjs decrypt "$workspace/other-key" \
  "$workspace/source.dump.enc" "$workspace/wrong.dump" >"$workspace/wrong.log" 2>&1; then
  echo >&2 'test failed: wrong recovery key was accepted'
  exit 1
fi
[[ ! -e "$workspace/wrong.dump" ]]

cp "$workspace/source.dump.enc" "$workspace/tampered.enc"
printf 'X' | dd of="$workspace/tampered.enc" bs=1 seek=25 count=1 conv=notrunc status=none
if node scripts/ops/backup-crypto.mjs decrypt "$workspace/key" \
  "$workspace/tampered.enc" "$workspace/tampered.dump" >"$workspace/tampered.log" 2>&1; then
  echo >&2 'test failed: tampered backup was accepted'
  exit 1
fi
[[ ! -e "$workspace/tampered.dump" ]]

mkdir "$workspace/bin" "$workspace/remote"
cp scripts/ops/test-fixtures/rclone "$workspace/bin/rclone"
cp scripts/ops/test-fixtures/docker-node-run.sh "$workspace/bin/docker"
chmod 0700 "$workspace/bin/rclone" "$workspace/bin/docker"
ln -s "$(command -v sha256sum)" "$workspace/bin/sha256sum"
export TEST_NODE=$(command -v node)
printf '[testremote]\ntype = local\n' >"$workspace/rclone.conf"
export PATH="$workspace/bin:/usr/bin:/bin"
! command -v node >/dev/null 2>&1
for invalid_image in "$(printf 'sha256:%064d raw-base node' 0)" "$(printf 'sha256:%064d privacy-ops root' 0)"; do
  if TEST_DOCKER_IMAGE_DETAILS="$invalid_image" scripts/ops/run-ops-node.sh -- -e 'process.exit(0)' \
    >"$workspace/invalid-image.log" 2>&1; then
    echo >&2 'test failed: unreviewed or root ops image was accepted'
    exit 1
  fi
  grep -q 'containerized operations runtime failed' "$workspace/invalid-image.log"
done
export RCLONE_CONFIG="$workspace/rclone.conf"
export WCTM_BACKUP_CRYPTO_KEY_FILE="$workspace/key"
printf '{"tenantId":"ten_fixture","storeId":"sto_fixture","baseUrlSha256":"%064d"}\n' 0 >"$workspace/ledger.jsonl"
scripts/ops/archive-erasure-ledger.sh "$workspace/ledger.jsonl" \
  "testremote:$workspace/remote" >"$workspace/archive.log"
[[ $(find "$workspace/remote" -maxdepth 1 -name '*.jsonl.enc' | wc -l | tr -d ' ') = 1 ]]
! grep -aq 'ten_fixture' "$workspace/remote"/*.jsonl.enc
grep -q 'erasure archive: PASS' "$workspace/archive.log"
mkdir "$workspace/ledger-restored"
encrypted_ledger=$(find "$workspace/remote" -maxdepth 1 -name '*.jsonl.enc' -print)
scripts/ops/restore-erasure-ledger.sh "$encrypted_ledger" "$workspace/ledger-restored" \
  >"$workspace/ledger-restore.log"
cmp "$workspace/ledger.jsonl" "$workspace/ledger-restored/erasure-ledger.jsonl"
grep -q 'erasure ledger restore: PASS' "$workspace/ledger-restore.log"
! grep -q 'synthetic customer marker' "$workspace"/*.log
echo 'backup encryption: PASS roundtrip wrong-key tamper encrypted-ledger-archive no-host-node reviewed-image fail-closed no-plaintext-output secret-safe-errors'
