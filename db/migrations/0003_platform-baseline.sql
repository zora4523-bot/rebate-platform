-- Up Migration
-- Platform baseline: idempotency keys, consumer de-duplication, domain event log and the
-- month-partition maintenance function (规划/02 §11, §18; 规划/04 §3.2; ADR-0001 §4.2 #4, #16).
-- Column shapes follow 规划/04 §3.2 and are provisional until task B1-01 finalises them.
-- Compatibility: additive. Recovery: restore from backup (no down migrations in this repo).
--
-- `app_id` has no foreign key yet: the `apps` table arrives with the baseline schema task
-- (10-06~08); that task adds the constraint.
-- `created_at DEFAULT now()` is the only SQL clock use allowed (规划/11 §4.2).

-- ---------------------------------------------------------------------------------------------
-- idempotency_keys: results of requests that carry an Idempotency-Key header
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.idempotency_keys (
  id           bigint GENERATED ALWAYS AS IDENTITY,
  app_id       text NOT NULL,
  subject      text NOT NULL,
  user_id      uuid,
  method       text NOT NULL,
  path         text NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  status       text NOT NULL,
  response     jsonb,
  expire_at    timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id),
  CONSTRAINT idempotency_keys_scope_key UNIQUE (app_id, subject, method, path, key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON app.idempotency_keys TO couli_app;
GRANT SELECT ON app.idempotency_keys TO couli_readonly;

-- ---------------------------------------------------------------------------------------------
-- processed_events: consumer-side de-duplication, written in the same transaction as the
-- consumer's side effect
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.processed_events (
  consumer   text NOT NULL,
  event_id   uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT processed_events_pkey PRIMARY KEY (consumer, event_id)
);

GRANT SELECT, INSERT ON app.processed_events TO couli_app, couli_payout;
GRANT SELECT ON app.processed_events TO couli_readonly;

-- ---------------------------------------------------------------------------------------------
-- Append-only guard. The only kind of trigger allowed (规划/02 §19): it rejects UPDATE and
-- DELETE for every role, including the table owner.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app.reject_update_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not allowed: append-only table',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

REVOKE ALL ON FUNCTION app.reject_update_delete() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- event_log: one row per domain event, written in the same transaction as the business write.
-- Audit and history only; delivery goes through the job queue and consumers never read it.
-- Partitioned by month on occurred_at; only the DEFAULT partition is created here. Month
-- partitions are created at runtime by app.ensure_month_partition. Rows in the DEFAULT
-- partition mean a month partition was missing and must raise an alert.
-- TODO(ADR-0001 §4.2 #16): dropping partitions past the retention period (>= 190 days) needs
-- its own SECURITY DEFINER function in a later migration — blocked on B1-01.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.event_log (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  app_id      text NOT NULL,
  event_id    uuid NOT NULL,
  name        text NOT NULL,
  payload     jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_log_pkey PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE app.event_log_default PARTITION OF app.event_log DEFAULT;

CREATE INDEX event_log_event_id_idx ON app.event_log (event_id);

CREATE TRIGGER event_log_append_only
  BEFORE UPDATE OR DELETE ON app.event_log
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

GRANT SELECT, INSERT ON app.event_log TO couli_app, couli_payout;
GRANT SELECT ON app.event_log TO couli_readonly;

-- ---------------------------------------------------------------------------------------------
-- ensure_month_partition: creates the partition of an allow-listed table for the month that
-- contains p_month and returns its name (`<table>_pYYYYMM`). Idempotent.
--
-- SECURITY DEFINER and owned by couli_migrator: a non-owner cannot create partitions even with
-- CREATE on the schema, and making couli_maint a member of the owner role would hand it all
-- DDL (ADR-0001 §4.2 #4, §7). Bounds are UTC month boundaries written as literals with an
-- explicit +00 offset, so they do not depend on the session time zone.
-- If the DEFAULT partition already holds rows of that month, PostgreSQL rejects the new
-- partition; the rows have to be moved out first.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app.ensure_month_partition(p_table text, p_month date)
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
  IF p_table NOT IN ('event_log') THEN
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
