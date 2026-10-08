-- Run as the database owner after creating wctm_retention with \password.
-- The role is cluster-level and is deliberately absent from pg_dump/Prisma migrations.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'wctm_retention') THEN
    RAISE EXCEPTION 'create the dedicated wctm_retention role first';
  END IF;
END
$guard$;

ALTER ROLE wctm_retention NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
REVOKE ALL ON SCHEMA public FROM wctm_retention;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM wctm_retention;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM wctm_retention;
REVOKE ALL ON DATABASE :"DBNAME" FROM wctm_retention;
GRANT CONNECT ON DATABASE :"DBNAME" TO wctm_retention;
GRANT USAGE ON SCHEMA public TO wctm_retention;

GRANT SELECT (id, expires_at) ON public.telegram_link_tokens TO wctm_retention;
GRANT DELETE ON public.telegram_link_tokens TO wctm_retention;
GRANT SELECT (id, registration_token_expires_at) ON public.stores TO wctm_retention;
GRANT UPDATE (registration_token_hash, registration_token_expires_at) ON public.stores TO wctm_retention;
GRANT SELECT (id, expires_at, note_body_encrypted) ON public.telegram_callback_references TO wctm_retention;
GRANT UPDATE (note_body_encrypted, note_content_fingerprint) ON public.telegram_callback_references TO wctm_retention;
GRANT SELECT (id, expires_at, query_encrypted) ON public.telegram_search_references TO wctm_retention;
GRANT UPDATE (query_encrypted) ON public.telegram_search_references TO wctm_retention;
GRANT SELECT (id, status, completed_at, failed_at, payload) ON public.webhook_events TO wctm_retention;
GRANT UPDATE (payload) ON public.webhook_events TO wctm_retention;
GRANT SELECT (id, created_at) ON public.audit_logs TO wctm_retention;
GRANT DELETE ON public.audit_logs TO wctm_retention;
COMMIT;
