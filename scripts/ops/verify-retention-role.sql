-- Owner-run, non-secret verification after applying postgres-retention-grants.sql.
\set ON_ERROR_STOP on
DO $verify$
DECLARE
  role_row pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO role_row FROM pg_catalog.pg_roles WHERE rolname = 'wctm_retention';
  IF NOT FOUND OR NOT role_row.rolcanlogin OR role_row.rolsuper OR
     role_row.rolcreatedb OR role_row.rolcreaterole OR role_row.rolinherit OR
     role_row.rolreplication OR role_row.rolbypassrls THEN
    RAISE EXCEPTION 'retention role flags failed';
  END IF;
  IF pg_catalog.has_schema_privilege('wctm_retention', 'public', 'CREATE') OR
     NOT pg_catalog.has_schema_privilege('wctm_retention', 'public', 'USAGE') OR
     pg_catalog.has_database_privilege('wctm_retention', current_database(), 'CREATE') OR
     pg_catalog.has_database_privilege('wctm_retention', current_database(), 'TEMP') OR
     EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = role_row.oid) OR
     EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = role_row.oid) THEN
    RAISE EXCEPTION 'retention role schema, ownership, membership, or database privileges failed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      AND pg_catalog.has_column_privilege('wctm_retention', c.oid, a.attname, 'SELECT')
      AND (c.relname, a.attname) NOT IN (
        ('telegram_link_tokens', 'id'), ('telegram_link_tokens', 'expires_at'),
        ('stores', 'id'), ('stores', 'registration_token_expires_at'),
        ('telegram_callback_references', 'id'), ('telegram_callback_references', 'expires_at'),
        ('telegram_callback_references', 'note_body_encrypted'),
        ('telegram_search_references', 'id'), ('telegram_search_references', 'expires_at'),
        ('telegram_search_references', 'query_encrypted'),
        ('webhook_events', 'id'), ('webhook_events', 'status'),
        ('webhook_events', 'completed_at'), ('webhook_events', 'failed_at'),
        ('webhook_events', 'payload'), ('audit_logs', 'id'), ('audit_logs', 'created_at')
      )
  ) THEN
    RAISE EXCEPTION 'retention SELECT column allowlist failed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND
      (pg_catalog.has_table_privilege('wctm_retention', c.oid, 'INSERT') OR
       (pg_catalog.has_table_privilege('wctm_retention', c.oid, 'DELETE') AND
        c.relname NOT IN ('telegram_link_tokens', 'audit_logs')) OR
       pg_catalog.has_table_privilege('wctm_runtime', c.oid, 'DELETE'))
  ) OR NOT pg_catalog.has_table_privilege('wctm_retention', 'public.telegram_link_tokens', 'DELETE') OR
       NOT pg_catalog.has_table_privilege('wctm_retention', 'public.audit_logs', 'DELETE') OR
       pg_catalog.has_table_privilege('wctm_retention', 'public._prisma_migrations', 'SELECT') OR
       pg_catalog.has_table_privilege('wctm_retention', 'public._prisma_migrations', 'UPDATE') OR
       pg_catalog.has_table_privilege('wctm_retention', 'public._prisma_migrations', 'DELETE') OR
       pg_catalog.has_table_privilege('wctm_runtime', 'public.audit_logs', 'UPDATE') THEN
    RAISE EXCEPTION 'retention table allowlist or runtime immutability failed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      AND pg_catalog.has_column_privilege('wctm_retention', c.oid, a.attname, 'UPDATE')
      AND (c.relname, a.attname) NOT IN (
        ('stores', 'registration_token_hash'), ('stores', 'registration_token_expires_at'),
        ('telegram_callback_references', 'note_body_encrypted'),
        ('telegram_callback_references', 'note_content_fingerprint'),
        ('telegram_search_references', 'query_encrypted'), ('webhook_events', 'payload')
      )
  ) THEN
    RAISE EXCEPTION 'retention UPDATE column allowlist failed';
  END IF;
  IF NOT pg_catalog.has_column_privilege('wctm_retention', 'public.stores', 'registration_token_hash', 'UPDATE') OR
     NOT pg_catalog.has_column_privilege('wctm_retention', 'public.stores', 'registration_token_expires_at', 'UPDATE') OR
     NOT pg_catalog.has_column_privilege('wctm_retention', 'public.telegram_callback_references', 'note_body_encrypted', 'UPDATE') OR
     NOT pg_catalog.has_column_privilege('wctm_retention', 'public.telegram_callback_references', 'note_content_fingerprint', 'UPDATE') OR
     NOT pg_catalog.has_column_privilege('wctm_retention', 'public.telegram_search_references', 'query_encrypted', 'UPDATE') OR
     NOT pg_catalog.has_column_privilege('wctm_retention', 'public.webhook_events', 'payload', 'UPDATE') THEN
    RAISE EXCEPTION 'required retention UPDATE column is missing';
  END IF;
END
$verify$;
SELECT 'retention role: PASS' AS result;
