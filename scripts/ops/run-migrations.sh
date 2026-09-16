#!/bin/sh
set -eu

if [ "${WCTM_MIGRATION_OPERATION:-}" != "P7_2_EXPLICIT_MIGRATION" ]; then
  echo >&2 'migration refused: use scripts/ops/migrate-production.sh'
  exit 64
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo >&2 'migration refused: DATABASE_URL is unavailable'
  exit 64
fi

node <<'NODE'
const value = process.env.DATABASE_URL;
try {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('unsupported scheme');
  }
  const username = decodeURIComponent(url.username);
  if (!username || username === 'wctm_runtime' || !url.password) {
    throw new Error('runtime or missing identity');
  }
} catch {
  console.error('migration refused: DATABASE_URL must use a distinct PostgreSQL migration identity');
  process.exit(64);
}
NODE

echo 'migration identity boundary: PASS (distinct non-runtime identity supplied for this operation)'
exec npm run prisma:migrate:deploy --workspace=@wc-telegram/backend
