#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  echo >&2 "postgres retention: $1"
  exit 1
}

[[ $# -eq 0 ]] || fail 'no arguments are accepted'
script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
[[ ${WCTM_COMPOSE_PROJECT:-} =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'a valid Compose project is required'
[[ ${WCTM_RETENTION_DATABASE:-} =~ ^[A-Za-z_][A-Za-z_0-9]*$ ]] || fail 'a valid database name is required'
credential_file=${WCTM_RETENTION_PGPASS_FILE:-}
[[ $credential_file = /* && -f $credential_file && ! -L $credential_file && -r $credential_file ]] ||
  fail 'a readable protected retention credential file is required'
[[ $credential_file != *','* && $credential_file != *$'\n'* ]] ||
  fail 'retention credential path contains an unsupported character'
mode=$(stat -c '%a' "$credential_file" 2>/dev/null || stat -f '%Lp' "$credential_file")
[[ $mode = 600 || $mode = 400 ]] || fail 'retention credential file must be mode 0600 or 0400'

# Require exactly one local connection entry for the dedicated identity.
IFS= read -r entry <"$credential_file" || [[ -n ${entry:-} ]]
[[ $entry = "127.0.0.1:5432:$WCTM_RETENTION_DATABASE:wctm_retention:"?* ]] ||
  fail 'retention credential must name the dedicated local database identity'
[[ $(wc -l <"$credential_file" | tr -d ' ') = 1 ]] ||
  fail 'retention credential must contain exactly one entry'
unset entry

image='postgres:16.15-alpine3.24@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685'
container_ids=$(docker ps --no-trunc --format '{{.ID}}' \
  --filter "label=com.docker.compose.project=$WCTM_COMPOSE_PROJECT" \
  --filter 'label=com.docker.compose.service=postgres') || fail 'PostgreSQL container lookup failed'
[[ $container_ids =~ ^[0-9a-f]{64}$ ]] || fail 'exactly one project PostgreSQL container must be running'
container_image=$(docker inspect --format '{{.Image}}' "$container_ids") || fail 'PostgreSQL image inspection failed'
reviewed_image=$(docker image inspect --format '{{.Id}}' "$image") || fail 'reviewed PostgreSQL image is unavailable locally'
[[ $container_image = "$reviewed_image" ]] || fail 'PostgreSQL container is not using the reviewed image'

echo 'postgres retention: starting fixed PPR-2 sweep'
if ! docker run --rm --pull=never --network "container:$container_ids" \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=64 \
  --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$credential_file,dst=/run/retention.pgpass,readonly" \
  --env PGPASSFILE=/run/retention.pgpass --entrypoint psql "$reviewed_image" \
  -X -q -w -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 \
  -U wctm_retention -d "$WCTM_RETENTION_DATABASE" -f - \
  <"$script_directory/postgres-retention.sql" >/dev/null 2>&1; then
  fail 'sweep failed; inspect dedicated role, grants, connectivity, and local PostgreSQL logs'
fi
echo 'postgres retention: PASS'
