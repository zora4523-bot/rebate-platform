-- Up Migration
-- Union raw payload archive (规划/04 §3.2 union_raw_payloads; 规划/02 §6.1 每次调用记请求摘要、
-- 响应原文、耗时、错误码; ADR-0001 §4.2 #4, #5 按月分区、DEFAULT 分区兜底). Task B1-04a.
-- Compatibility: additive (one new partitioned table with its DEFAULT partition, a guard trigger
-- and grants) plus CREATE OR REPLACE of app.ensure_month_partition that only extends its
-- allow-list. Recovery: restore from backup; no down migration.
--
-- union_raw_payloads: one row per union API call or fetched document, insert-only.
-- - id is a bigint identity so app.orders.raw_payload_id (0007) can point at it. That reference
--   is logical only: a partitioned table is never an FK target (db/AGENTS.md rule 7).
-- - Partitioned by RANGE (fetched_at); the primary key therefore contains fetched_at, as orders
--   and event_log do. Only the DEFAULT partition is created here; month partitions are created
--   at runtime by app.ensure_month_partition (pnpm db:partitions), so this migration has no
--   date-dependent DDL. Rows in the DEFAULT partition mean a month partition was missing.
-- - fetched_at comes from the injected Clock and has no default; created_at defaults to now()
--   only as the technical insert time.
-- - platform and kind are open text: 04 lists kind as order / rights / query… without a full set.
-- - payload holds the compressed response bytes; content_hash is the writer's hash of them.
-- - request_summary is a JSON object describing the request. It must never contain appKey,
--   secret, sign, session, access_token or client_secret (09 README redaction rule); the writer
--   (union adapters, task B1-04p) guarantees this, the database cannot.
-- - latency_ms is the call duration; error_code is NULL for a successful call.
-- Retention: none yet. The 180-day rule (BR-ID-30 ⑦) needs app.drop_expired_month_partitions and
-- platform/maintenance DROPPABLE_TABLES to change together; split out to a follow-up task
-- (couli-runs/B1-followups-5-work/followups.md, F5-1). Until then drop_expired_month_partitions
-- keeps rejecting this table.
--
-- Grants: couli_app SELECT and INSERT only (never UPDATE, DELETE or TRUNCATE; the append-only
-- trigger is a second line of defence); couli_readonly SELECT. couli_payout gets nothing;
-- couli_maint only reaches the table through the SECURITY DEFINER ensure_month_partition.
--
-- Timeouts: creating an empty table and replacing one function take only short catalog locks;
-- 5s lock wait so a blocked deploy fails fast, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.union_raw_payloads (
  id              bigint GENERATED ALWAYS AS IDENTITY,
  app_id          text NOT NULL,
  platform        text NOT NULL,
  kind            text NOT NULL,
  payload         bytea NOT NULL,
  fetched_at      timestamptz NOT NULL,
  content_hash    text NOT NULL,
  request_summary jsonb NOT NULL,
  latency_ms      integer NOT NULL,
  error_code      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT union_raw_payloads_pkey PRIMARY KEY (id, fetched_at),
  CONSTRAINT union_raw_payloads_request_summary_check
    CHECK (jsonb_typeof(request_summary) = 'object'),
  CONSTRAINT union_raw_payloads_latency_check CHECK (latency_ms >= 0)
) PARTITION BY RANGE (fetched_at);

CREATE TABLE app.union_raw_payloads_default PARTITION OF app.union_raw_payloads DEFAULT;

CREATE TRIGGER union_raw_payloads_append_only
  BEFORE UPDATE OR DELETE ON app.union_raw_payloads
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

GRANT SELECT, INSERT ON app.union_raw_payloads TO couli_app;
GRANT SELECT ON app.union_raw_payloads TO couli_readonly;

-- Keep the existing function (0007) unchanged: UTC boundaries, advisory lock, safe search_path
-- and role boundary. Only its allow-list gains union_raw_payloads (db/AGENTS.md rule 5; mirrored
-- by MONTH_PARTITIONED_TABLES in packages/db/src/partitions.ts).
CREATE OR REPLACE FUNCTION app.ensure_month_partition(p_table text, p_month date)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_start  date;
  v_end    date;
  v_name   text;
  v_parent oid;
  v_child  oid;
BEGIN
  IF p_table IS NULL OR p_month IS NULL THEN
    RAISE EXCEPTION 'ensure_month_partition: p_table and p_month are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Allow-list of month-partitioned tables (ADR-0001 §4.2 #5). Extend it in the migration
  -- that creates the next partitioned table.
  IF p_table NOT IN ('event_log', 'orders', 'union_raw_payloads') THEN
    RAISE EXCEPTION 'ensure_month_partition: table "%" is not month-partitioned', p_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- date -> timestamp (without time zone) casts keep every step independent of the session
  -- time zone.
  v_start := make_date(extract(year FROM p_month)::int, extract(month FROM p_month)::int, 1);
  v_end   := (v_start + interval '1 month')::date;
  v_name  := p_table || '_p' || to_char(v_start::timestamp, 'YYYYMM');

  -- Serialise concurrent callers for the same partition.
  PERFORM pg_advisory_xact_lock(hashtextextended('app.ensure_month_partition:' || v_name, 0));

  SELECT c.oid INTO v_parent
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = p_table AND c.relkind = 'p';
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'ensure_month_partition: app.% is not a partitioned table', p_table
      USING ERRCODE = 'undefined_table';
  END IF;

  SELECT c.oid INTO v_child
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = v_name;
  IF v_child IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM pg_inherits i WHERE i.inhrelid = v_child AND i.inhparent = v_parent
    ) THEN
      RETURN v_name;
    END IF;
    RAISE EXCEPTION 'ensure_month_partition: app.% exists but is not a partition of app.%',
      v_name, p_table
      USING ERRCODE = 'duplicate_table';
  END IF;

  EXECUTE format(
    'CREATE TABLE app.%I PARTITION OF app.%I FOR VALUES FROM (%L) TO (%L)',
    v_name,
    p_table,
    to_char(v_start::timestamp, 'YYYY-MM-DD') || ' 00:00:00+00',
    to_char(v_end::timestamp, 'YYYY-MM-DD') || ' 00:00:00+00'
  );

  RETURN v_name;
END
$$;

REVOKE ALL ON FUNCTION app.ensure_month_partition(text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ensure_month_partition(text, date) TO couli_maint;
