-- Fixed PPR-2 table/column allowlist. No caller-supplied SQL or identifiers.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
DO $retention$
DECLARE
  affected integer;
  batch integer;
  token_cutoff timestamptz := transaction_timestamp() - interval '1 day';
  completed_cutoff timestamptz := transaction_timestamp() - interval '30 days';
  failed_cutoff timestamptz := transaction_timestamp() - interval '90 days';
  audit_cutoff timestamptz := transaction_timestamp() - interval '365 days';
BEGIN
  IF current_user <> 'wctm_retention' THEN
    RAISE EXCEPTION 'dedicated retention identity required';
  END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(20261007, 1) THEN
    RAISE EXCEPTION 'retention operation already running';
  END IF;

  -- Each table is limited to 20 batches of 500 per invocation. Later daily
  -- invocations drain any remaining backlog without unbounded transactions.
  FOR batch IN 1..20 LOOP
    WITH selected AS (
      SELECT id FROM public.telegram_link_tokens
      WHERE expires_at < token_cutoff ORDER BY expires_at
      LIMIT 500
    )
    DELETE FROM public.telegram_link_tokens target USING selected
    WHERE target.id = selected.id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected < 500;
  END LOOP;

  FOR batch IN 1..20 LOOP
    WITH selected AS (
      SELECT id FROM public.stores
      WHERE registration_token_expires_at < token_cutoff
      ORDER BY registration_token_expires_at LIMIT 500
    )
    UPDATE public.stores target SET registration_token_hash = NULL,
      registration_token_expires_at = NULL FROM selected
    WHERE target.id = selected.id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected < 500;
  END LOOP;

  FOR batch IN 1..20 LOOP
    WITH selected AS (
      SELECT id FROM public.telegram_callback_references
      WHERE expires_at < token_cutoff AND note_body_encrypted IS NOT NULL
      ORDER BY expires_at LIMIT 500
    )
    UPDATE public.telegram_callback_references target
    SET note_body_encrypted = NULL, note_content_fingerprint = NULL
    FROM selected WHERE target.id = selected.id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected < 500;
  END LOOP;

  FOR batch IN 1..20 LOOP
    WITH selected AS (
      SELECT id FROM public.telegram_search_references
      WHERE expires_at < token_cutoff AND query_encrypted IS NOT NULL
      ORDER BY expires_at LIMIT 500
    )
    UPDATE public.telegram_search_references target SET query_encrypted = NULL
    FROM selected WHERE target.id = selected.id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected < 500;
  END LOOP;

  FOR batch IN 1..20 LOOP
    WITH selected AS (
      SELECT id FROM public.webhook_events
      WHERE status = 'COMPLETED' AND completed_at < completed_cutoff
        AND payload <> '{}'::jsonb
      ORDER BY completed_at LIMIT 500
    )
    UPDATE public.webhook_events target SET payload = '{}'::jsonb
    FROM selected WHERE target.id = selected.id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected < 500;
  END LOOP;

  FOR batch IN 1..20 LOOP
    WITH selected AS (
      SELECT id FROM public.webhook_events
      WHERE status = 'FAILED' AND failed_at < failed_cutoff
        AND payload <> '{}'::jsonb
      ORDER BY failed_at LIMIT 500
    )
    UPDATE public.webhook_events target SET payload = '{}'::jsonb
    FROM selected WHERE target.id = selected.id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected < 500;
  END LOOP;

  FOR batch IN 1..20 LOOP
    WITH selected AS (
      SELECT id FROM public.audit_logs
      WHERE created_at < audit_cutoff ORDER BY created_at
      LIMIT 500
    )
    DELETE FROM public.audit_logs target USING selected
    WHERE target.id = selected.id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    EXIT WHEN affected < 500;
  END LOOP;
END
$retention$;
COMMIT;
