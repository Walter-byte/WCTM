#!/bin/sh
set -eu

container_id=$(docker compose ps -q backend)
[ -n "$container_id" ] || {
  echo >&2 'runtime-role verification failed: backend container is not running'
  exit 1
}

docker compose exec -T backend node <<'NODE'
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT
        current_user AS role_name,
        r.rolsuper,
        r.rolcreatedb,
        r.rolcreaterole,
        r.rolinherit,
        r.rolreplication,
        r.rolbypassrls,
        has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
        has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
        has_database_privilege(current_user, current_database(), 'TEMP') AS database_temp,
        has_table_privilege(current_user, 'public._prisma_migrations', 'SELECT') OR
          has_table_privilege(current_user, 'public._prisma_migrations', 'INSERT') OR
          has_table_privilege(current_user, 'public._prisma_migrations', 'UPDATE') OR
          has_table_privilege(current_user, 'public._prisma_migrations', 'DELETE') AS migration_table_dml,
        (SELECT count(*)::int FROM pg_class WHERE relowner = r.oid) AS owned_objects
      FROM pg_roles r
      WHERE r.rolname = current_user
    `);
    const row = result.rows[0];
    const passed = row?.role_name === 'wctm_runtime' &&
      !row.rolsuper && !row.rolcreatedb && !row.rolcreaterole &&
      !row.rolinherit && !row.rolreplication && !row.rolbypassrls &&
      row.schema_usage && !row.schema_create && !row.database_temp &&
      !row.migration_table_dml && row.owned_objects === 0;
    console.log(JSON.stringify({
      role: row?.role_name,
      elevatedFlags: Boolean(row?.rolsuper || row?.rolcreatedb || row?.rolcreaterole || row?.rolinherit || row?.rolreplication || row?.rolbypassrls),
      schemaUsage: row?.schema_usage,
      schemaCreate: row?.schema_create,
      databaseTemp: row?.database_temp,
      migrationTableDml: row?.migration_table_dml,
      ownedObjects: row?.owned_objects,
      passed,
    }));
    if (!passed) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch(() => {
  console.error('runtime-role verification failed');
  process.exitCode = 1;
});
NODE
