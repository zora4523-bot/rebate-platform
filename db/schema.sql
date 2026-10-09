--
-- PostgreSQL database dump
--

\restrict couli


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: app; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA app;


--
-- Name: pgboss; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA pgboss;


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: job_state; Type: TYPE; Schema: pgboss; Owner: -
--

CREATE TYPE pgboss.job_state AS ENUM (
    'created',
    'retry',
    'active',
    'completed',
    'cancelled',
    'failed'
);


--
-- Name: delete_expired_link_open_attempts(timestamp with time zone, integer); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.delete_expired_link_open_attempts(p_now timestamp with time zone, p_batch_size integer) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET lock_timeout TO '5s'
    AS $$
DECLARE
  v_cutoff  timestamptz;
  v_deleted bigint;
BEGIN
  IF p_now IS NULL OR p_batch_size IS NULL THEN
    RAISE EXCEPTION 'delete_expired_link_open_attempts: p_now and p_batch_size are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'delete_expired_link_open_attempts: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'delete_expired_link_open_attempts: p_batch_size must be between 1 and 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Fixed UTC+08:00, never the session TimeZone. Subtract calendar days before converting
  -- local midnight back to an instant (BR-ID-30 正文: run day 00:00 +08:00 − 90 days).
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - 90)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  -- One bounded batch over every app_id. SKIP LOCKED: a row a writer holds is left for a
  -- later batch instead of making maintenance wait; table-level waits are capped by the
  -- function's lock_timeout.
  WITH victims AS (
    SELECT a.attempt_id
    FROM app.link_open_attempts a
    WHERE a.opened_at < v_cutoff
    ORDER BY a.opened_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM app.link_open_attempts t
  USING victims v
  WHERE t.attempt_id = v.attempt_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;


--
-- Name: drop_expired_day_partitions(text, timestamp with time zone); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.drop_expired_day_partitions(p_table text, p_now timestamp with time zone) RETURNS text[]
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET lock_timeout TO '5s'
    SET "DateStyle" TO 'ISO, YMD'
    SET "TimeZone" TO 'UTC'
    AS $_$
DECLARE
  v_parent     oid;
  v_cutoff     timestamptz;
  v_partition  record;
  v_bounds     text[];
  v_candidates text[] := ARRAY[]::text[];
  v_name       text;
  v_dropped    text[] := ARRAY[]::text[];
BEGIN
  IF p_table IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'drop_expired_day_partitions: p_table and p_now are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'drop_expired_day_partitions: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_table <> 'link_logs' THEN
    RAISE EXCEPTION 'drop_expired_day_partitions: table "%" has no partition retention rule', p_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Serialise deletion calls before listing so each drop is reported once.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('app.drop_expired_day_partitions:' || p_table, 0)
  );

  SELECT c.oid INTO v_parent
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = p_table AND c.relkind = 'p';
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'drop_expired_day_partitions: app.% is not a partitioned table', p_table
      USING ERRCODE = 'undefined_table';
  END IF;

  -- BR-ID-30: midnight of the supplied +08:00 calendar day minus 90 days.
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - 90)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  FOR v_partition IN
    SELECT c.relname::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = v_parent AND n.nspname = 'app' AND c.relkind = 'r'
      AND c.relname::text ~ ('^' || p_table || '_p[0-9]{8}$')
    ORDER BY c.relname COLLATE "C"
  LOOP
    -- Use actual catalogue bounds, never infer age from a partition's name.
    -- DEFAULT, unbounded ranges and unfamiliar bound shapes are left untouched.
    v_bounds := regexp_match(v_partition.bound,
      $bound$^FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)$bound$);
    IF v_bounds IS NOT NULL AND isfinite(v_bounds[2]::timestamptz)
      AND v_bounds[2]::timestamptz <= v_cutoff THEN
      v_candidates := array_append(v_candidates, v_partition.name);
    END IF;
  END LOOP;

  -- Empty runs do not request a lock on link_logs or any of its partitions.
  IF cardinality(v_candidates) = 0 THEN
    RETURN v_dropped;
  END IF;

  -- Take ALL candidate creation locks before the parent lock. Otherwise an
  -- ensure caller could hold a later candidate lock while waiting for our parent.
  FOREACH v_name IN ARRAY v_candidates LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('app.ensure_day_partition:' || v_name, 0));
  END LOOP;

  -- Parent before children follows writer lock order; ONLY avoids unrelated and
  -- DEFAULT partitions. Every wait, including advisory locks, has a 5s bound.
  -- Do not catch 55P03: the whole statement must roll back, including earlier drops.
  EXECUTE format('LOCK TABLE ONLY app.%I IN ACCESS EXCLUSIVE MODE', p_table);

  -- Membership and actual bounds are checked again after the wait under lock.
  FOR v_partition IN
    SELECT c.relname::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = v_parent AND n.nspname = 'app' AND c.relkind = 'r'
      AND c.relname::text = ANY (v_candidates)
    ORDER BY c.relname COLLATE "C"
  LOOP
    v_bounds := regexp_match(v_partition.bound,
      $bound$^FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)$bound$);
    IF v_bounds IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT isfinite(v_bounds[2]::timestamptz) OR v_bounds[2]::timestamptz > v_cutoff THEN
      CONTINUE;
    END IF;

    -- created_at is the partition key: an upper bound <= cutoff guarantees that
    -- every row is strictly older than cutoff, without scanning or deleting rows.
    EXECUTE format('DROP TABLE app.%I', v_partition.name);
    v_dropped := array_append(v_dropped, v_partition.name);
  END LOOP;

  RETURN v_dropped;
END
$_$;


--
-- Name: drop_expired_month_partitions(text, timestamp with time zone); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.drop_expired_month_partitions(p_table text, p_now timestamp with time zone) RETURNS text[]
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET lock_timeout TO '5s'
    SET "DateStyle" TO 'ISO, YMD'
    SET "TimeZone" TO 'UTC'
    AS $_$
DECLARE
  v_parent     oid;
  v_cutoff     timestamptz;
  v_partition  record;
  v_bounds     text[];
  v_candidates text[] := ARRAY[]::text[];
  v_name       text;
  v_latest     timestamptz;
  v_dropped    text[] := ARRAY[]::text[];
BEGIN
  IF p_table IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'drop_expired_month_partitions: p_table and p_now are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'drop_expired_month_partitions: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Deny these names even before their tables exist. Everything else also needs an
  -- explicit retention rule below; adding a table must never implicitly enable deletion.
  IF p_table = ANY (ARRAY[
    'orders', 'order_keys', 'order_status_history', 'order_rights', 'order_settlements',
    'commission_splits', 'settle_bills', 'settle_batches', 'settle_batch_items',
    'settle_adjustments', 'claims', 'claim_items', 'ledger_vouchers', 'ledger_entries',
    'withdrawals', 'payout_attempts', 'audit_logs'
  ]) THEN
    RAISE EXCEPTION 'drop_expired_month_partitions: partitions of app.% are kept until their retention period is confirmed', p_table
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF p_table <> 'event_log' THEN
    RAISE EXCEPTION 'drop_expired_month_partitions: table "%" has no partition retention rule', p_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Serialise deletion callers BEFORE inspecting the catalogue. Per-partition locks
  -- below share exactly the namespace used by ensure_month_partition.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('app.drop_expired_month_partitions:' || p_table, 0)
  );

  SELECT c.oid INTO v_parent
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = p_table AND c.relkind = 'p';
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'drop_expired_month_partitions: app.% is not a partitioned table', p_table
      USING ERRCODE = 'undefined_table';
  END IF;

  -- A fixed transaction snapshot could hide a writer that committed while we waited
  -- for a lock. Refuse that mode rather than risk deleting a recently created row.
  -- VOLATILE + READ COMMITTED gives the post-lock statement a fresh snapshot.
  IF current_setting('transaction_isolation') = ANY (ARRAY['repeatable read', 'serializable']) THEN
    RAISE EXCEPTION 'drop_expired_month_partitions: requires read committed isolation'
      USING ERRCODE = 'invalid_transaction_state';
  END IF;

  -- Fixed UTC+08:00, never the session TimeZone or a zone with historical DST.
  -- Subtract calendar days before converting local midnight back to an instant.
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - 190)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  FOR v_partition IN
    SELECT c.relname::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = v_parent AND n.nspname = 'app' AND c.relkind = 'r'
      AND c.relname::text ~ ('^' || p_table || '_p[0-9]{4}(0[1-9]|1[0-2])$')
    ORDER BY c.relname COLLATE "C"
  LOOP
    -- Inspect the ACTUAL range, not a date inferred from the name. DEFAULT, unbounded
    -- ranges and unfamiliar bound shapes fail closed. pg_get_expr emits timestamptz
    -- values with their offsets, so parsing them preserves the actual boundary.
    v_bounds := regexp_match(v_partition.bound,
      $bound$^FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)$bound$);
    IF v_bounds IS NOT NULL AND isfinite(v_bounds[2]::timestamptz)
      AND v_bounds[2]::timestamptz <= v_cutoff THEN
      -- Read-only preflight: a recent row already rules out deletion, so do not
      -- queue an exclusive parent lock for this partition. Recheck under lock below
      -- because concurrent writers may commit after this snapshot.
      -- max() is answered from the end of the created_at index (one probe, no
      -- statistics needed); NULL means an empty partition.
      EXECUTE format('SELECT max(created_at) FROM app.%I', v_partition.name) INTO v_latest;
      IF v_latest IS NULL OR v_latest < v_cutoff THEN
        v_candidates := array_append(v_candidates, v_partition.name);
      END IF;
    END IF;
  END LOOP;

  IF cardinality(v_candidates) = 0 THEN
    RETURN v_dropped;
  END IF;

  -- Acquire all creation locks before taking exclusive relation locks: otherwise an ensure
  -- caller could hold a later partition's advisory lock while waiting for our parent.
  FOREACH v_name IN ARRAY v_candidates LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('app.ensure_month_partition:' || v_name, 0));
  END LOOP;

  -- DROP also needs the parent's exclusive lock. Take it before child locks to avoid
  -- deadlocking writers that lock the parent first and then route into a child.
  -- ONLY avoids recursively locking unrelated/default partitions.
  -- Every lock wait is bounded by the function's 5s lock_timeout. Let SQLSTATE 55P03
  -- abort the statement (rolling back all its drops); the worker logs one failure
  -- and retries on its next run, without leaving a queued exclusive lock behind.
  EXECUTE format('LOCK TABLE ONLY app.%I IN ACCESS EXCLUSIVE MODE', p_table);

  -- Re-list after waiting, checking membership and bounds again under the parent lock.
  FOR v_partition IN
    SELECT c.relname::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = v_parent AND n.nspname = 'app' AND c.relkind = 'r'
      AND c.relname::text = ANY (v_candidates)
    ORDER BY c.relname COLLATE "C"
  LOOP
    v_bounds := regexp_match(v_partition.bound,
      $bound$^FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)$bound$);
    IF v_bounds IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT isfinite(v_bounds[2]::timestamptz) OR v_bounds[2]::timestamptz > v_cutoff THEN
      CONTINUE;
    END IF;

    EXECUTE format('LOCK TABLE app.%I IN ACCESS EXCLUSIVE MODE', v_partition.name);
    -- Separate statement AFTER lock acquisition: includes writers that committed while
    -- we waited. Equality keeps the entire partition; never delete individual rows.
    -- Same index-end probe as the preflight, so the exclusive lock is held only briefly.
    EXECUTE format('SELECT max(created_at) FROM app.%I', v_partition.name) INTO v_latest;
    IF v_latest IS NULL OR v_latest < v_cutoff THEN
      EXECUTE format('DROP TABLE app.%I', v_partition.name);
      v_dropped := array_append(v_dropped, v_partition.name);
    END IF;
  END LOOP;

  RETURN v_dropped;
END
$_$;


--
-- Name: ensure_day_partition(text, date); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.ensure_day_partition(p_table text, p_day date) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET lock_timeout TO '5s'
    SET "DateStyle" TO 'ISO, YMD'
    SET "TimeZone" TO 'UTC'
    AS $$
DECLARE
  v_name   text;
  v_parent oid;
  v_child  oid;
  v_start  timestamptz;
  v_end    timestamptz;
BEGIN
  IF p_table IS NULL OR p_day IS NULL THEN
    RAISE EXCEPTION 'ensure_day_partition: p_table and p_day are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Extend only in a migration that adds another day-partitioned table.
  IF p_table <> 'link_logs' THEN
    RAISE EXCEPTION 'ensure_day_partition: table "%" is not day-partitioned', p_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF NOT isfinite(p_day) OR p_day < DATE '2000-01-01' OR p_day > DATE '9999-12-31' THEN
    RAISE EXCEPTION 'ensure_day_partition: p_day must be between 2000-01-01 and 9999-12-31'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_name := p_table || '_p' || to_char(p_day::timestamp, 'YYYYMMDD');

  -- Share this transaction lock with deletion. Catalogue queries after the wait
  -- see a preceding caller's committed DDL under READ COMMITTED.
  PERFORM pg_advisory_xact_lock(hashtextextended('app.ensure_day_partition:' || v_name, 0));

  SELECT c.oid INTO v_parent
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = p_table AND c.relkind = 'p';
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'ensure_day_partition: app.% is not a partitioned table', p_table
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
      -- No DDL or relation lock when the requested partition already exists.
      RETURN v_name;
    END IF;
    RAISE EXCEPTION 'ensure_day_partition: app.% exists but is not a partition of app.%',
      v_name, p_table
      USING ERRCODE = 'duplicate_table';
  END IF;

  -- Add a calendar day before converting to an instant, including 9999-12-31's
  -- upper boundary. Fixed offsets avoid session time zones and historical DST.
  v_start := p_day::timestamp AT TIME ZONE INTERVAL '8 hours';
  v_end := (p_day + 1)::timestamp AT TIME ZONE INTERVAL '8 hours';

  -- PostgreSQL checks DEFAULT rows and clones constraints/indexes/triggers.
  -- Propagate 23514 unchanged if DEFAULT contains rows of this day. All waits
  -- (advisory, parent, DEFAULT and referenced tables) are bounded by 5s; 55P03
  -- aborts the statement and releases its locks without a partial creation.
  EXECUTE format(
    'CREATE TABLE app.%I PARTITION OF app.%I FOR VALUES FROM (%L) TO (%L)',
    v_name, p_table, v_start, v_end
  );

  RETURN v_name;
END
$$;


--
-- Name: ensure_month_partition(text, date); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.ensure_month_partition(p_table text, p_month date) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
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
  IF p_table NOT IN ('event_log', 'orders') THEN
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


--
-- Name: partition_default_rows(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.partition_default_rows() RETURNS TABLE(table_name text, default_partition text, row_count bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE
  v_partition record;
BEGIN
  -- Discover every app DEFAULT partition, including tables added by later migrations.
  -- Count real rows (not pg_class estimates); return counts only, never row contents.
  FOR v_partition IN
    SELECT p.relname::text AS parent_name, d.relname::text AS child_name,
      dn.nspname::text AS child_schema
    FROM pg_partitioned_table pt
    JOIN pg_class p ON p.oid = pt.partrelid
    JOIN pg_namespace pn ON pn.oid = p.relnamespace
    JOIN pg_class d ON d.oid = pt.partdefid
    JOIN pg_namespace dn ON dn.oid = d.relnamespace
    WHERE pn.nspname = 'app'
    ORDER BY p.relname COLLATE "C"
  LOOP
    table_name := v_partition.parent_name;
    default_partition := v_partition.child_name;
    EXECUTE format('SELECT count(*) FROM %I.%I',
      v_partition.child_schema, v_partition.child_name) INTO row_count;
    RETURN NEXT;
  END LOOP;
END
$$;


--
-- Name: reject_agent_run_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_agent_run_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(NEW.id, NEW.app_id, NEW.session_id, NEW.prompt_version, NEW.accepted_at,
         NEW.quota_subjects, NEW.created_at, NEW.deadline_at)
      IS DISTINCT FROM
      ROW(OLD.id, OLD.app_id, OLD.session_id, OLD.prompt_version, OLD.accepted_at,
          OLD.quota_subjects, OLD.created_at, OLD.deadline_at)
    OR (OLD.final_event IS NOT NULL AND NEW.final_event IS DISTINCT FROM OLD.final_event)
    OR (OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at)
    OR (OLD.end_reason IS NOT NULL AND NEW.end_reason IS DISTINCT FROM OLD.end_reason)
    OR (OLD.settle_result IS NOT NULL AND NEW.settle_result IS DISTINCT FROM OLD.settle_result)
    OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at)
    OR (OLD.card_delivered AND NOT NEW.card_delivered)
    OR (OLD.settle_result IS NOT NULL AND NEW.card_delivered IS DISTINCT FROM OLD.card_delivered)
    OR (NEW.user_text IS NOT NULL AND NEW.user_text IS DISTINCT FROM OLD.user_text)
    OR (OLD.end_draft IS NOT NULL AND NEW.end_draft IS DISTINCT FROM OLD.end_draft)
    OR (OLD.cancel_requested_at IS NOT NULL
        AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at)
  THEN
    RAISE EXCEPTION 'agent_runs ending facts are write-once and user_text may only be cleared'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_agent_session_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_agent_session_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(NEW.id, NEW.app_id, NEW.user_id, NEW.device_id, NEW.started_at, NEW.created_at)
      IS DISTINCT FROM
      ROW(OLD.id, OLD.app_id, OLD.user_id, OLD.device_id, OLD.started_at, OLD.created_at)
    OR NEW.card_seq < OLD.card_seq
  THEN
    RAISE EXCEPTION 'agent_sessions owner is immutable and card_seq never decreases'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_device_registration_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_device_registration_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF OLD.merged_into_user_id IS NOT NULL
    OR NEW.merged_into_user_id IS NULL
    OR ROW(NEW.app_id, NEW.device_hash, NEW.user_id, NEW.register_method, NEW.created_at)
      IS DISTINCT FROM
      ROW(OLD.app_id, OLD.device_hash, OLD.user_id, OLD.register_method, OLD.created_at)
  THEN
    RAISE EXCEPTION 'device_registrations only permits setting an empty merge target once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_link_open_attempt_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_link_open_attempt_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(NEW.attempt_id, NEW.app_id, NEW.link_id, NEW.user_id, NEW.opened_at)
      IS DISTINCT FROM
      ROW(OLD.attempt_id, OLD.app_id, OLD.link_id, OLD.user_id, OLD.opened_at)
    OR (OLD.jump_reported_at IS NOT NULL
      AND NEW.jump_reported_at IS DISTINCT FROM OLD.jump_reported_at)
    OR (OLD.dismissed_at IS NOT NULL
      AND NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at)
  THEN
    RAISE EXCEPTION 'link_open_attempts identity is immutable and timestamps are write-once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_link_promo_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_link_promo_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF (OLD.promo_url IS NOT NULL AND NEW.promo_url IS DISTINCT FROM OLD.promo_url)
    OR (OLD.promo_url_fetched_at IS NOT NULL
      AND NEW.promo_url_fetched_at IS DISTINCT FROM OLD.promo_url_fetched_at)
  THEN
    RAISE EXCEPTION 'links promotion link is write-once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_link_quote_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_link_quote_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(NEW.app_id, NEW.link_id) IS DISTINCT FROM ROW(OLD.app_id, OLD.link_id)
    OR (OLD.quoted_final_price_fen IS NOT NULL
      AND NEW.quoted_final_price_fen IS DISTINCT FROM OLD.quoted_final_price_fen)
    OR (OLD.quoted_coupon_fen IS NOT NULL
      AND NEW.quoted_coupon_fen IS DISTINCT FROM OLD.quoted_coupon_fen)
    OR (OLD.quoted_coupon_id IS NOT NULL
      AND NEW.quoted_coupon_id IS DISTINCT FROM OLD.quoted_coupon_id)
    OR (OLD.quoted_at IS NOT NULL
      AND ROW(NEW.quoted_final_price_fen, NEW.quoted_coupon_fen, NEW.quoted_coupon_id, NEW.quoted_at)
        IS DISTINCT FROM
        ROW(OLD.quoted_final_price_fen, OLD.quoted_coupon_fen, OLD.quoted_coupon_id, OLD.quoted_at))
  THEN
    RAISE EXCEPTION 'links identity and written quote snapshot are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_order_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_order_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(NEW.order_id, NEW.app_id, NEW.platform, NEW.sub_order_id, NEW.attr_at)
      IS DISTINCT FROM
      ROW(OLD.order_id, OLD.app_id, OLD.platform, OLD.sub_order_id, OLD.attr_at)
    OR (OLD.product_key IS NOT NULL AND NEW.product_key IS DISTINCT FROM OLD.product_key)
    OR (OLD.settle_period IS NOT NULL AND NEW.settle_period IS DISTINCT FROM OLD.settle_period)
    OR (OLD.credit_requires_settle AND NOT NEW.credit_requires_settle)
  THEN
    RAISE EXCEPTION 'orders identity, written product/period and settlement requirement cannot be rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_product_ref_key_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_product_ref_key_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(NEW.app_id, NEW.product_key, NEW.platform)
    IS DISTINCT FROM ROW(OLD.app_id, OLD.product_key, OLD.platform)
  THEN
    RAISE EXCEPTION 'product_refs identity (app_id, product_key, platform) is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_union_auth_session_rewrite(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_union_auth_session_rewrite() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  IF ROW(NEW.state, NEW.app_id, NEW.user_id, NEW.device_id, NEW.platform, NEW.mode,
         NEW.link_id, NEW.expire_at, NEW.created_at, NEW.client, NEW.auth_methods,
         NEW.auth_app_refs)
      IS DISTINCT FROM
      ROW(OLD.state, OLD.app_id, OLD.user_id, OLD.device_id, OLD.platform, OLD.mode,
          OLD.link_id, OLD.expire_at, OLD.created_at, OLD.client, OLD.auth_methods,
          OLD.auth_app_refs)
    OR (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
  THEN
    RAISE EXCEPTION 'union_auth_sessions are immutable and used_at is write-once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: reject_update_delete(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reject_update_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not allowed: append-only table',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;


--
-- Name: create_queue(text, jsonb); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.create_queue(queue_name text, options jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $_$
    DECLARE
      tablename varchar := CASE WHEN options->>'partition' = 'true'
                            THEN 'j' || encode(sha224(queue_name::bytea), 'hex')
                            ELSE 'job_common'
                            END;
      queue_created_on timestamptz;
    BEGIN

      WITH q as (
        INSERT INTO pgboss.queue (
          name,
          policy,
          retry_limit,
          retry_delay,
          retry_backoff,
          retry_delay_max,
          expire_seconds,
          retention_seconds,
          deletion_seconds,
          warning_queued,
          dead_letter,
          partition,
          table_name,
          heartbeat_seconds,
          notify,
          created_on,
          updated_on
        )
        VALUES (
          queue_name,
          options->>'policy',
          COALESCE((options->>'retryLimit')::int, 2),
          COALESCE((options->>'retryDelay')::int, 0),
          COALESCE((options->>'retryBackoff')::bool, false),
          (options->>'retryDelayMax')::int,
          COALESCE((options->>'expireInSeconds')::int, 900),
          COALESCE((options->>'retentionSeconds')::int, 1209600),
          COALESCE((options->>'deleteAfterSeconds')::int, 604800),
          COALESCE((options->>'warningQueueSize')::int, 0),
          options->>'deadLetter',
          COALESCE((options->>'partition')::bool, false),
          tablename,
          (options->>'heartbeatSeconds')::int,
          COALESCE((options->>'notify')::bool, false),
          pgboss.job_now(),
          pgboss.job_now()
        )
        ON CONFLICT DO NOTHING
        RETURNING created_on
      )
      SELECT created_on into queue_created_on from q;

      IF queue_created_on IS NULL OR options->>'partition' IS DISTINCT FROM 'true' THEN
        RETURN;
      END IF;

      EXECUTE format('CREATE TABLE pgboss.%I (LIKE pgboss.job INCLUDING DEFAULTS)', tablename);

      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD PRIMARY KEY (name, id)$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue (name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED$cmd$, tablename);

      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i11 ON pgboss.job (name, priority DESC, created_on, start_after) WHERE state < 'active' AND NOT blocked$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i4 ON pgboss.job (name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled' AND singleton_on IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i7 ON pgboss.job (name, group_id) WHERE state = 'active' AND group_id IS NOT NULL$cmd$, tablename);
      EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i9 ON pgboss.job (name, id) WHERE blocking AND state = 'completed'$cmd$, tablename);

      IF options->>'policy' = 'short' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short'$cmd$, tablename);
      ELSIF options->>'policy' = 'singleton' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i2 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'active' AND policy = 'singleton'$cmd$, tablename);
      ELSIF options->>'policy' = 'stately' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i3 ON pgboss.job (name, state, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'stately'$cmd$, tablename);
      ELSIF options->>'policy' = 'exclusive' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i6 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state <= 'active' AND policy = 'exclusive'$cmd$, tablename);
      ELSIF options->>'policy' = 'key_strict_fifo' THEN
        EXECUTE pgboss.job_table_format($cmd$CREATE UNIQUE INDEX job_i8 ON pgboss.job (name, singleton_key) WHERE state IN ('active', 'retry', 'failed') AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE pgboss.job_table_format($cmd$CREATE INDEX job_i10 ON pgboss.job (name, singleton_key, state DESC, created_on, id) INCLUDE (start_after) WHERE state < 'active' AND NOT blocked AND policy = 'key_strict_fifo'$cmd$, tablename);
        EXECUTE pgboss.job_table_format($cmd$ALTER TABLE pgboss.job ADD CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK (NOT (policy = 'key_strict_fifo' AND singleton_key IS NULL))$cmd$, tablename);
      END IF;

      EXECUTE format('ALTER TABLE pgboss.%I ADD CONSTRAINT cjc CHECK (name=%L)', tablename, queue_name);
      EXECUTE format('ALTER TABLE pgboss.job ATTACH PARTITION pgboss.%I FOR VALUES IN (%L)', tablename, queue_name);
    END;
    $_$;


--
-- Name: delete_queue(text); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.delete_queue(queue_name text) RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_table varchar;
      v_partition bool;
    BEGIN
      
      SELECT table_name, partition
      FROM pgboss.queue
      WHERE name = queue_name
      INTO v_table, v_partition;

      IF v_partition THEN
        EXECUTE format('DROP TABLE IF EXISTS pgboss.%I', v_table);
      ELSE
        EXECUTE format('DELETE FROM pgboss.%I WHERE name = %L', v_table, queue_name);
      END IF;
    
      DELETE FROM pgboss.queue WHERE name = queue_name;
    END;
    $$;


--
-- Name: job_now(); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.job_now() RETURNS timestamp with time zone
    LANGUAGE sql STABLE
    AS $$
      SELECT pg_catalog.now();
    $$;


--
-- Name: job_table_format(text, text); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.job_table_format(command text, table_name text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $_$
      SELECT format(
        regexp_replace(
          regexp_replace(command, '\.job\y', '.%1$I', 'g'),
          '\yjob_i(\d+)', '%1$s_i\1', 'g'
        ),
        table_name
      );
    $_$;


--
-- Name: job_table_run(text, text, text); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.job_table_run(command text, tbl_name text DEFAULT NULL::text, queue_name text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE
      tbl RECORD;
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        EXECUTE pgboss.job_table_format(command, tbl_name);
        RETURN;
      END IF;

      EXECUTE pgboss.job_table_format(command, 'job_common');

      FOR tbl IN SELECT table_name FROM pgboss.queue WHERE partition = true
      LOOP
        EXECUTE pgboss.job_table_format(command, tbl.table_name);
      END LOOP;
    END;
    $$;


--
-- Name: job_table_run_async(text, integer, text, text, text); Type: FUNCTION; Schema: pgboss; Owner: -
--

CREATE FUNCTION pgboss.job_table_run_async(command_name text, version integer, command text, tbl_name text DEFAULT NULL::text, queue_name text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF queue_name IS NOT NULL THEN
        SELECT table_name INTO tbl_name FROM pgboss.queue WHERE name = queue_name;
      END IF;

      IF tbl_name IS NOT NULL THEN
        INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
        VALUES (
          command_name,
          version,
          'pending',
          queue_name,
          tbl_name,
          pgboss.job_table_format(command, tbl_name)
        );
        RETURN;
      END IF;

      INSERT INTO pgboss.bam (name, version, status, queue, table_name, command)
      SELECT
        command_name,
        version,
        'pending',
        NULL,
        'job_common',
        pgboss.job_table_format(command, 'job_common')
      UNION ALL
      SELECT
        command_name,
        version,
        'pending',
        queue.name,
        queue.table_name,
        pgboss.job_table_format(command, queue.table_name)
      FROM pgboss.queue
      WHERE partition = true;
    END;
    $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_permissions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.admin_permissions (
    id bigint NOT NULL,
    app_id text NOT NULL,
    admin_id uuid NOT NULL,
    permission_key text NOT NULL,
    granted_by uuid NOT NULL,
    granted_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_permissions_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.admin_permissions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.admin_permissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: admin_users; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.admin_users (
    id uuid NOT NULL,
    app_id text NOT NULL,
    login_name text NOT NULL,
    password_hash text NOT NULL,
    totp_secret_cipher bytea,
    totp_bound_at timestamp with time zone,
    totp_last_step bigint,
    is_super boolean NOT NULL,
    status text NOT NULL,
    verify_phone_cipher bytea,
    verify_phone_hmac text,
    verify_phone_set_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_cards; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.agent_cards (
    id uuid NOT NULL,
    app_id text NOT NULL,
    session_id uuid NOT NULL,
    run_id uuid NOT NULL,
    card_id text NOT NULL,
    type text NOT NULL,
    data jsonb NOT NULL,
    link_id uuid,
    schema_version integer NOT NULL,
    fallback_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_cards_card_id_check CHECK ((card_id ~ '^c[1-9][0-9]*$'::text)),
    CONSTRAINT agent_cards_data_check CHECK ((jsonb_typeof(data) = 'object'::text)),
    CONSTRAINT agent_cards_earnings_no_amount_check CHECK (
CASE
    WHEN (type <> 'earnings_summary'::text) THEN true
    WHEN (jsonb_typeof(data) = 'object'::text) THEN (((data - 'as_of'::text) - 'actions'::text) = '{}'::jsonb)
    ELSE false
END),
    CONSTRAINT agent_cards_fallback_text_check CHECK ((fallback_text <> ''::text)),
    CONSTRAINT agent_cards_schema_version_check CHECK ((schema_version >= 1)),
    CONSTRAINT agent_cards_type_check CHECK ((type = ANY (ARRAY['product_list'::text, 'rebate_quote'::text, 'order_status'::text, 'claim_draft'::text, 'handoff'::text, 'auth_required'::text, 'notice'::text, 'rule_ref'::text, 'page_guide'::text, 'earnings_summary'::text])))
);


--
-- Name: agent_messages; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.agent_messages (
    id uuid NOT NULL,
    app_id text NOT NULL,
    session_id uuid NOT NULL,
    run_id uuid,
    client_msg_id text,
    role text NOT NULL,
    text text,
    card_ids text[] DEFAULT '{}'::text[] NOT NULL,
    feedback text,
    feedback_at timestamp with time zone,
    reported boolean DEFAULT false NOT NULL,
    report_reason text,
    reported_at timestamp with time zone,
    report_status text,
    report_handler_id uuid,
    report_handled_at timestamp with time zone,
    report_note text,
    badcase boolean DEFAULT false NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_messages_assistant_client_check CHECK (((role <> 'assistant'::text) OR (client_msg_id IS NULL))),
    CONSTRAINT agent_messages_card_ids_check CHECK (
CASE
    WHEN (cardinality(card_ids) = 0) THEN true
    WHEN (array_ndims(card_ids) = 1) THEN
    CASE
        WHEN (array_position(card_ids, NULL::text) IS NULL) THEN ((array_to_string(card_ids, ','::text) ~ '^c[1-9][0-9]*(,c[1-9][0-9]*)*$'::text) AND (cardinality(string_to_array(array_to_string(card_ids, ','::text), ','::text)) = cardinality(card_ids)))
        ELSE false
    END
    ELSE false
END),
    CONSTRAINT agent_messages_down_badcase_check CHECK (((feedback IS DISTINCT FROM 'down'::text) OR badcase)),
    CONSTRAINT agent_messages_feedback_check CHECK ((feedback = ANY (ARRAY['up'::text, 'down'::text]))),
    CONSTRAINT agent_messages_feedback_pair_check CHECK (((feedback IS NULL) = (feedback_at IS NULL))),
    CONSTRAINT agent_messages_report_handled_check CHECK ((((NOT (report_status IS DISTINCT FROM 'handled'::text)) = (report_handled_at IS NOT NULL)) AND ((NOT (report_status IS DISTINCT FROM 'handled'::text)) = (report_handler_id IS NOT NULL)))),
    CONSTRAINT agent_messages_report_status_check CHECK ((report_status = ANY (ARRAY['pending'::text, 'handled'::text]))),
    CONSTRAINT agent_messages_report_status_pair_check CHECK ((reported = (report_status IS NOT NULL))),
    CONSTRAINT agent_messages_reported_pair_check CHECK ((reported = (reported_at IS NOT NULL))),
    CONSTRAINT agent_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text]))),
    CONSTRAINT agent_messages_user_keys_check CHECK (((role <> 'user'::text) OR ((client_msg_id IS NOT NULL) AND (run_id IS NOT NULL)))),
    CONSTRAINT agent_messages_user_no_feedback_check CHECK (((role <> 'user'::text) OR ((feedback IS NULL) AND (feedback_at IS NULL) AND (NOT reported))))
);


--
-- Name: agent_result_sets; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.agent_result_sets (
    id uuid NOT NULL,
    app_id text NOT NULL,
    run_id uuid NOT NULL,
    conditions jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_result_sets_conditions_check CHECK ((jsonb_typeof(conditions) = 'object'::text))
);


--
-- Name: agent_runs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.agent_runs (
    id uuid NOT NULL,
    app_id text NOT NULL,
    session_id uuid NOT NULL,
    user_text text,
    intent text,
    model text,
    model_snapshot text,
    prompt_version text NOT NULL,
    input_tokens integer,
    output_tokens integer,
    cost_mfen bigint,
    ttft_ms integer,
    latency_ms integer,
    finish_reason text,
    final_event jsonb,
    ended_at timestamp with time zone,
    output_filtered boolean DEFAULT false NOT NULL,
    filter_hits text[] DEFAULT '{}'::text[] NOT NULL,
    output_truncated boolean DEFAULT false NOT NULL,
    price_version text,
    result_check_provider text,
    judge_model text,
    page_guide_reject_reason text,
    accepted_at timestamp with time zone NOT NULL,
    quota_subjects text[] NOT NULL,
    end_reason text,
    card_delivered boolean DEFAULT false NOT NULL,
    settle_result text,
    settled_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deadline_at timestamp with time zone,
    end_draft jsonb,
    cancel_requested_at timestamp with time zone,
    finalize_hold text,
    finalize_hold_at timestamp with time zone,
    CONSTRAINT agent_runs_cancel_order_check CHECK ((cancel_requested_at >= accepted_at)),
    CONSTRAINT agent_runs_counts_check CHECK (((input_tokens >= 0) AND (output_tokens >= 0) AND (cost_mfen >= 0) AND (ttft_ms >= 0) AND (latency_ms >= 0))),
    CONSTRAINT agent_runs_deadline_order_check CHECK ((deadline_at >= accepted_at)),
    CONSTRAINT agent_runs_end_draft_check CHECK (((end_draft IS NULL) OR COALESCE(
CASE
    WHEN (jsonb_typeof(end_draft) = 'object'::text) THEN ((end_draft ?& ARRAY['type'::text, 'data'::text]) AND (((end_draft - 'type'::text) - 'data'::text) = '{}'::jsonb) AND (jsonb_typeof((end_draft -> 'type'::text)) = 'string'::text) AND ((end_draft ->> 'type'::text) = ANY (ARRAY['done'::text, 'error'::text])) AND (jsonb_typeof((end_draft -> 'data'::text)) = 'object'::text))
    ELSE false
END, false))),
    CONSTRAINT agent_runs_end_draft_reason_check CHECK (((end_draft IS NULL) OR (end_reason IS NOT NULL))),
    CONSTRAINT agent_runs_ended_order_check CHECK ((ended_at >= accepted_at)),
    CONSTRAINT agent_runs_filter_hits_check CHECK (
CASE
    WHEN (cardinality(filter_hits) = 0) THEN true
    WHEN (array_ndims(filter_hits) = 1) THEN
    CASE
        WHEN (array_position(filter_hits, NULL::text) IS NULL) THEN (filter_hits <@ ARRAY['amount'::text, 'url'::text, 'tpwd'::text])
        ELSE false
    END
    ELSE false
END),
    CONSTRAINT agent_runs_final_after_settle_check CHECK (((final_event IS NULL) OR (settle_result IS NOT NULL))),
    CONSTRAINT agent_runs_final_event_check CHECK (((final_event IS NULL) OR COALESCE(
CASE
    WHEN (jsonb_typeof(final_event) = 'object'::text) THEN ((final_event ?& ARRAY['type'::text, 'data'::text]) AND (((final_event - 'type'::text) - 'data'::text) = '{}'::jsonb) AND (jsonb_typeof((final_event -> 'type'::text)) = 'string'::text) AND ((final_event ->> 'type'::text) = ANY (ARRAY['done'::text, 'error'::text])) AND (jsonb_typeof((final_event -> 'data'::text)) = 'object'::text))
    ELSE false
END, false))),
    CONSTRAINT agent_runs_final_pair_check CHECK (((final_event IS NULL) = (ended_at IS NULL))),
    CONSTRAINT agent_runs_finalize_hold_check CHECK ((finalize_hold = ANY (ARRAY['stored_frame_invalid'::text, 'facts_inconsistent'::text]))),
    CONSTRAINT agent_runs_finalize_hold_open_check CHECK (((finalize_hold IS NULL) OR (final_event IS NULL))),
    CONSTRAINT agent_runs_finalize_hold_pair_check CHECK (((finalize_hold IS NULL) = (finalize_hold_at IS NULL))),
    CONSTRAINT agent_runs_finish_reason_check CHECK ((finish_reason = ANY (ARRAY['stop'::text, 'cancelled'::text, 'limit'::text, 'budget'::text, 'error'::text, 'auth_required'::text, 'safety'::text, 'fallback'::text, 'timeout'::text]))),
    CONSTRAINT agent_runs_intent_check CHECK ((intent = ANY (ARRAY['find_by_link'::text, 'search'::text, 'refine'::text, 'order_query'::text, 'rule_qa'::text, 'handoff'::text, 'clarify'::text, 'out_of_scope'::text, 'page_guide'::text, 'earnings_query'::text]))),
    CONSTRAINT agent_runs_output_filtered_check CHECK ((output_filtered = (cardinality(filter_hits) > 0))),
    CONSTRAINT agent_runs_page_guide_reject_reason_check CHECK ((page_guide_reject_reason = ANY (ARRAY['not_allowed'::text, 'extra_fields'::text, 'disabled'::text, 'untrusted_input'::text, 'params_requested'::text]))),
    CONSTRAINT agent_runs_quota_subjects_check CHECK (
CASE
    WHEN (array_ndims(quota_subjects) = 1) THEN
    CASE
        WHEN (array_position(quota_subjects, NULL::text) IS NULL) THEN ((cardinality(quota_subjects) >= 1) AND (cardinality(quota_subjects) <= 2))
        ELSE false
    END
    ELSE false
END),
    CONSTRAINT agent_runs_result_check_provider_check CHECK ((result_check_provider = ANY (ARRAY['rules'::text, 'jev'::text]))),
    CONSTRAINT agent_runs_settle_after_end_check CHECK (((settle_result IS NULL) OR (end_reason IS NOT NULL))),
    CONSTRAINT agent_runs_settle_pair_check CHECK (((settle_result IS NULL) = (settled_at IS NULL))),
    CONSTRAINT agent_runs_settle_result_check CHECK ((settle_result = ANY (ARRAY['counted'::text, 'refunded'::text])))
);


--
-- Name: agent_sessions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.agent_sessions (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    device_id uuid NOT NULL,
    started_at timestamp with time zone NOT NULL,
    last_active_at timestamp with time zone NOT NULL,
    expired_at timestamp with time zone,
    card_seq integer DEFAULT 0 NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    run_lock_run_id uuid,
    run_lock_expires_at timestamp with time zone,
    CONSTRAINT agent_sessions_active_order_check CHECK ((last_active_at >= started_at)),
    CONSTRAINT agent_sessions_card_seq_check CHECK ((card_seq >= 0)),
    CONSTRAINT agent_sessions_expired_order_check CHECK ((expired_at > last_active_at)),
    CONSTRAINT agent_sessions_run_lock_pair_check CHECK (((run_lock_run_id IS NULL) = (run_lock_expires_at IS NULL)))
);


--
-- Name: agent_tool_calls; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.agent_tool_calls (
    id uuid NOT NULL,
    app_id text NOT NULL,
    run_id uuid NOT NULL,
    seq integer NOT NULL,
    name text NOT NULL,
    args jsonb,
    result_digest text,
    status text NOT NULL,
    latency_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_tool_calls_latency_check CHECK ((latency_ms >= 0)),
    CONSTRAINT agent_tool_calls_seq_check CHECK ((seq >= 1))
);


--
-- Name: app_versions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.app_versions (
    id uuid NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    channel text NOT NULL,
    latest_version text NOT NULL,
    min_supported_version text,
    recommended_version text,
    update_title text NOT NULL,
    update_notes text NOT NULL,
    store_url text NOT NULL,
    default_store text NOT NULL,
    store_listings jsonb NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT app_versions_latest_version_check CHECK ((latest_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'::text)),
    CONSTRAINT app_versions_min_supported_version_check CHECK ((min_supported_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'::text)),
    CONSTRAINT app_versions_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'harmony'::text, 'h5'::text, 'admin'::text]))),
    CONSTRAINT app_versions_recommended_version_check CHECK ((recommended_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'::text)),
    CONSTRAINT app_versions_store_listings_array_check CHECK ((jsonb_typeof(store_listings) = 'array'::text))
);


--
-- Name: appeals; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.appeals (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    target_type text NOT NULL,
    request_type text,
    target_id text NOT NULL,
    related_phone_hmac text,
    prev_risk_state text,
    status text NOT NULL,
    content text NOT NULL,
    deadline_at timestamp with time zone NOT NULL,
    handler_id text,
    closed_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT appeals_account_target_check CHECK (((target_type <> 'account'::text) OR (target_id = (user_id)::text))),
    CONSTRAINT appeals_closed_check CHECK (((status = 'processing'::text) = (closed_at IS NULL))),
    CONSTRAINT appeals_handler_check CHECK (((status = 'processing'::text) OR (handler_id IS NOT NULL))),
    CONSTRAINT appeals_order_target_check CHECK (((target_type <> 'order'::text) OR (target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text))),
    CONSTRAINT appeals_prev_risk_state_check CHECK (
CASE
    WHEN (target_type = 'account'::text) THEN ((prev_risk_state IS NOT NULL) AND (prev_risk_state = ANY (ARRAY['banned'::text, 'frozen'::text])))
    ELSE (prev_risk_state IS NULL)
END),
    CONSTRAINT appeals_related_phone_check CHECK (
CASE
    WHEN (request_type = ANY (ARRAY['register'::text, 'phone_change'::text])) THEN (related_phone_hmac IS NOT NULL)
    WHEN (request_type IS NULL) THEN (related_phone_hmac IS NULL)
    ELSE true
END),
    CONSTRAINT appeals_request_check CHECK (((target_type = 'blocked_request'::text) = (request_type IS NOT NULL))),
    CONSTRAINT appeals_request_type_check CHECK ((request_type = ANY (ARRAY['register'::text, 'withdraw'::text, 'phone_change'::text, 'payout_account'::text]))),
    CONSTRAINT appeals_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'upheld'::text, 'revoked'::text]))),
    CONSTRAINT appeals_target_type_check CHECK ((target_type = ANY (ARRAY['account'::text, 'order'::text, 'blocked_request'::text]))),
    CONSTRAINT appeals_user_check CHECK (
CASE
    WHEN (request_type = 'register'::text) THEN (user_id IS NULL)
    ELSE (user_id IS NOT NULL)
END)
);


--
-- Name: articles; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.articles (
    id uuid NOT NULL,
    app_id text NOT NULL,
    category text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    status text NOT NULL,
    published_at timestamp with time zone,
    notice_closable boolean NOT NULL,
    notice_content_version integer DEFAULT 1 NOT NULL,
    notice_end_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT articles_category_check CHECK ((category = ANY (ARRAY['help'::text, 'rule'::text, 'notice'::text, 'agreement'::text]))),
    CONSTRAINT articles_notice_content_version_check CHECK ((notice_content_version >= 1)),
    CONSTRAINT articles_version_check CHECK ((version >= 1))
);


--
-- Name: audit_logs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.audit_logs (
    id bigint NOT NULL,
    app_id text NOT NULL,
    admin_id uuid NOT NULL,
    action text NOT NULL,
    target text,
    before jsonb,
    after jsonb,
    ip inet,
    at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_logs_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.audit_logs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: blocklist; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.blocklist (
    id uuid NOT NULL,
    app_id text NOT NULL,
    dimension text NOT NULL,
    value_hmac text,
    value text,
    violation_type text NOT NULL,
    reason text,
    platform text,
    union_account_id uuid,
    start_at timestamp with time zone,
    end_at timestamp with time zone,
    expire_at timestamp with time zone,
    status text NOT NULL,
    created_by text NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT blocklist_account_expire_check CHECK (((dimension = ANY (ARRAY['order_no_suffix'::text, 'channel'::text])) OR (expire_at IS NOT NULL))),
    CONSTRAINT blocklist_channel_check CHECK (
CASE
    WHEN (dimension = 'channel'::text) THEN ((union_account_id IS NOT NULL) AND (start_at IS NOT NULL) AND ((end_at IS NULL) OR (end_at > start_at)))
    ELSE ((union_account_id IS NULL) AND (start_at IS NULL) AND (end_at IS NULL))
END),
    CONSTRAINT blocklist_device_check CHECK (((dimension <> 'device'::text) OR (value_hmac ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT blocklist_dimension_check CHECK ((dimension = ANY (ARRAY['phone'::text, 'id_no'::text, 'alipay'::text, 'bank_card'::text, 'wechat_openid'::text, 'device'::text, 'relation_id'::text, 'order_no_suffix'::text, 'channel'::text]))),
    CONSTRAINT blocklist_order_no_suffix_check CHECK (((dimension <> 'order_no_suffix'::text) OR ((platform = 'taobao'::text) AND (char_length(value) = 6)))),
    CONSTRAINT blocklist_platform_check CHECK (((dimension = ANY (ARRAY['order_no_suffix'::text, 'channel'::text])) = (platform IS NOT NULL))),
    CONSTRAINT blocklist_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text]))),
    CONSTRAINT blocklist_storage_check CHECK (
CASE
    WHEN (dimension = ANY (ARRAY['order_no_suffix'::text, 'channel'::text])) THEN ((value IS NOT NULL) AND (value_hmac IS NULL))
    ELSE ((value_hmac IS NOT NULL) AND (value IS NULL))
END),
    CONSTRAINT blocklist_violation_type_check CHECK ((violation_type = ANY (ARRAY['malicious_rights'::text, 'fraud_invite'::text, 'other'::text])))
);


--
-- Name: category_blocklist; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.category_blocklist (
    id uuid NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    category_id text NOT NULL,
    keyword text,
    reason text NOT NULL,
    status text NOT NULL,
    updated_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: config_items; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.config_items (
    app_id text NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_by text NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT config_items_version_check CHECK ((version >= 1))
);


--
-- Name: consent_records; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.consent_records (
    id bigint NOT NULL,
    app_id text NOT NULL,
    subject_type text NOT NULL,
    user_id uuid,
    device_id uuid,
    type text NOT NULL,
    version integer NOT NULL,
    channel text NOT NULL,
    accepted boolean NOT NULL,
    client_at timestamp with time zone NOT NULL,
    server_at timestamp with time zone NOT NULL,
    text_sha256 text,
    signer_snapshot jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT consent_records_channel_check CHECK ((channel = ANY (ARRAY['first_launch'::text, 'login_page'::text, 'h5_landing'::text, 'agent_sheet'::text, 'realname_sheet'::text, 'privacy_center'::text, 'login_merge'::text, 'withdraw_flow'::text]))),
    CONSTRAINT consent_records_labor_agreement_check CHECK (((type <> 'labor_agreement'::text) OR ((subject_type = 'user'::text) AND (text_sha256 IS NOT NULL) AND (signer_snapshot IS NOT NULL) AND (device_id IS NOT NULL)))),
    CONSTRAINT consent_records_subject_check CHECK ((((subject_type = 'user'::text) AND (user_id IS NOT NULL)) OR ((subject_type = 'device'::text) AND (device_id IS NOT NULL)))),
    CONSTRAINT consent_records_subject_type_check CHECK ((subject_type = ANY (ARRAY['user'::text, 'device'::text]))),
    CONSTRAINT consent_records_type_check CHECK ((type = ANY (ARRAY['privacy'::text, 'agreement'::text, 'ai_third_party'::text, 'id_verification'::text, 'personalization'::text, 'labor_agreement'::text])))
);


--
-- Name: consent_records_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.consent_records ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.consent_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: device_registrations; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.device_registrations (
    app_id text NOT NULL,
    device_hash text NOT NULL,
    user_id uuid NOT NULL,
    register_method text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    merged_into_user_id uuid
);


--
-- Name: devices; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.devices (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    device_hash text NOT NULL,
    id_source text NOT NULL,
    platform text NOT NULL,
    app_version text NOT NULL,
    last_login_sid text,
    revoked_at timestamp with time zone,
    last_seen_at timestamp with time zone NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    install_secret_cipher bytea NOT NULL,
    CONSTRAINT devices_device_hash_check CHECK ((device_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT devices_id_source_check CHECK ((id_source = ANY (ARRAY['idfv'::text, 'android_id'::text, 'oaid'::text, 'odid'::text]))),
    CONSTRAINT devices_install_secret_present_check CHECK (((revoked_at IS NOT NULL) OR (octet_length(install_secret_cipher) > 0)))
);


--
-- Name: event_log; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.event_log (
    id bigint NOT NULL,
    app_id text NOT NULL,
    event_id uuid NOT NULL,
    name text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
)
PARTITION BY RANGE (occurred_at);


--
-- Name: event_log_default; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.event_log_default (
    id bigint CONSTRAINT event_log_id_not_null NOT NULL,
    app_id text CONSTRAINT event_log_app_id_not_null NOT NULL,
    event_id uuid CONSTRAINT event_log_event_id_not_null NOT NULL,
    name text CONSTRAINT event_log_name_not_null NOT NULL,
    payload jsonb CONSTRAINT event_log_payload_not_null NOT NULL,
    occurred_at timestamp with time zone CONSTRAINT event_log_occurred_at_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT event_log_created_at_not_null NOT NULL
);


--
-- Name: event_log_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.event_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.event_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: idempotency_keys; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.idempotency_keys (
    id bigint NOT NULL,
    app_id text NOT NULL,
    subject text NOT NULL,
    user_id uuid,
    method text NOT NULL,
    path text NOT NULL,
    key text NOT NULL,
    request_hash text,
    status text NOT NULL,
    response jsonb,
    expire_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT idempotency_keys_request_data_check CHECK ((((status = 'abandoned'::text) AND (request_hash IS NULL) AND (response IS NULL)) OR ((status = ANY (ARRAY['processing'::text, 'completed'::text])) AND (request_hash IS NOT NULL)))),
    CONSTRAINT idempotency_keys_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'completed'::text, 'abandoned'::text])))
);


--
-- Name: idempotency_keys_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.idempotency_keys ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.idempotency_keys_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inbox_messages; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.inbox_messages (
    message_id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    code text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    route jsonb,
    read_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: link_logs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.link_logs (
    id bigint NOT NULL,
    app_id text NOT NULL,
    link_id uuid,
    event text NOT NULL,
    user_id uuid,
    opener_user_id uuid,
    platform text,
    product_key text,
    raw_item_id text,
    shop_id text,
    scene text,
    pid_scene text,
    spm text,
    pid text,
    relation_id text,
    client text,
    cache_hit boolean DEFAULT false NOT NULL,
    expired boolean DEFAULT false NOT NULL,
    quoted_price_fen bigint,
    no_rebate boolean DEFAULT false NOT NULL,
    no_rebate_reason text,
    agent_session_id uuid,
    agent_message_id uuid,
    prompt_version text,
    model text,
    result_code integer NOT NULL,
    latency_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT link_logs_event_check CHECK ((event = ANY (ARRAY['convert'::text, 'precompute'::text, 'register'::text, 'open'::text])))
)
PARTITION BY RANGE (created_at);


--
-- Name: link_logs_default; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.link_logs_default (
    id bigint CONSTRAINT link_logs_id_not_null NOT NULL,
    app_id text CONSTRAINT link_logs_app_id_not_null NOT NULL,
    link_id uuid,
    event text CONSTRAINT link_logs_event_not_null NOT NULL,
    user_id uuid,
    opener_user_id uuid,
    platform text,
    product_key text,
    raw_item_id text,
    shop_id text,
    scene text,
    pid_scene text,
    spm text,
    pid text,
    relation_id text,
    client text,
    cache_hit boolean DEFAULT false CONSTRAINT link_logs_cache_hit_not_null NOT NULL,
    expired boolean DEFAULT false CONSTRAINT link_logs_expired_not_null NOT NULL,
    quoted_price_fen bigint,
    no_rebate boolean DEFAULT false CONSTRAINT link_logs_no_rebate_not_null NOT NULL,
    no_rebate_reason text,
    agent_session_id uuid,
    agent_message_id uuid,
    prompt_version text,
    model text,
    result_code integer CONSTRAINT link_logs_result_code_not_null NOT NULL,
    latency_ms integer,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT link_logs_created_at_not_null NOT NULL,
    CONSTRAINT link_logs_event_check CHECK ((event = ANY (ARRAY['convert'::text, 'precompute'::text, 'register'::text, 'open'::text])))
);


--
-- Name: link_logs_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.link_logs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.link_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: link_open_attempts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.link_open_attempts (
    attempt_id uuid NOT NULL,
    app_id text NOT NULL,
    link_id uuid NOT NULL,
    user_id uuid,
    opened_at timestamp with time zone NOT NULL,
    jump_reported_at timestamp with time zone,
    dismissed_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: links; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.links (
    link_id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    device_id uuid,
    platform text NOT NULL,
    product_key text,
    raw_item_id text,
    raw_fetched_at timestamp with time zone,
    scene text NOT NULL,
    sub_scene text,
    pid_scene text,
    pid text,
    entry_source text,
    identity_snapshot jsonb,
    convert_result bytea,
    cache_hit boolean DEFAULT false NOT NULL,
    quoted_final_price_fen bigint,
    quoted_coupon_fen bigint,
    quoted_coupon_id text,
    quoted_at timestamp with time zone,
    expire_at timestamp with time zone NOT NULL,
    agent_session_id uuid,
    agent_card_id text,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    promo_url text,
    promo_url_fetched_at timestamp with time zone
);


--
-- Name: login_logs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.login_logs (
    id bigint NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    device_id_hash text NOT NULL,
    ip inet NOT NULL,
    method text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: login_logs_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.login_logs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.login_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: order_keys; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.order_keys (
    platform text NOT NULL,
    sub_order_id text NOT NULL,
    order_id uuid NOT NULL,
    app_id text NOT NULL,
    attr_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: order_rights; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.order_rights (
    id uuid NOT NULL,
    app_id text NOT NULL,
    order_id uuid NOT NULL,
    source text NOT NULL,
    type text NOT NULL,
    status text NOT NULL,
    amount_fen bigint,
    deduction_commission_fen bigint,
    occurred_at timestamp with time zone NOT NULL,
    platform_rights_no text,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_rights_status_check CHECK ((status = ANY (ARRAY['PROCESSING'::text, 'WAIT_COMMISSION'::text, 'SUCCEEDED'::text, 'FAILED'::text]))),
    CONSTRAINT order_rights_type_check CHECK ((type = ANY (ARRAY['RIGHTS'::text, 'PUNISH'::text, 'INVALID_AFTER_SETTLE'::text, 'REFUND_AFTER_SETTLE'::text])))
);


--
-- Name: order_settlements; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.order_settlements (
    app_id text NOT NULL,
    order_id uuid NOT NULL,
    seq integer NOT NULL,
    source text NOT NULL,
    settle_commission_fen bigint NOT NULL,
    settled_at timestamp with time zone NOT NULL,
    content_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_settlements_source_check CHECK ((source = ANY (ARRAY['API'::text, 'STATEMENT'::text])))
);


--
-- Name: orders; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.orders (
    order_id uuid NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    sub_order_id text NOT NULL,
    parent_order_id text,
    shop_type text,
    product_key text,
    raw_item_id text NOT NULL,
    shop_id text,
    title text,
    image_url text,
    quantity integer,
    refunded_quantity integer,
    refunded_quantity_at_credit integer,
    pay_amount_fen bigint,
    pid text,
    relation_id text,
    sub_union_id text,
    custom_params text,
    link_id uuid,
    source_match text,
    user_id uuid,
    buy_type text,
    scene_basis text,
    user_basis text,
    platform_status text NOT NULL,
    rebate_status text DEFAULT 'UNATTRIBUTED'::text NOT NULL,
    hold boolean DEFAULT false NOT NULL,
    hold_reason text,
    rights_pending boolean DEFAULT false NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    commission_version integer DEFAULT 0 NOT NULL,
    reason text,
    reason_sub text,
    diff_reason_code text,
    is_presale boolean DEFAULT false NOT NULL,
    deposit_paid_at timestamp with time zone,
    paid_at timestamp with time zone,
    paid_at_source text,
    attr_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone,
    platform_received_at timestamp with time zone,
    received_synced_at timestamp with time zone,
    settled_at timestamp with time zone,
    union_settled_at timestamp with time zone,
    settle_period text,
    platform_modified_at timestamp with time zone,
    credit_requires_settle boolean DEFAULT false NOT NULL,
    credited_at timestamp with time zone,
    est_commission_fen bigint,
    settle_commission_fen bigint,
    subsidy_commission_fen bigint,
    booked_base_fen bigint,
    booked_n_fen bigint,
    initial_est_fen bigint,
    n_total_fen bigint,
    pre_base_deduct_fen bigint,
    base_fen bigint,
    platform_est_profit_fen bigint,
    commission_rate_bp integer,
    is_price_compare boolean,
    commission_rate_min_bp integer,
    commission_rate_max_bp integer,
    activity_type text,
    source_scene text,
    agent_session_id uuid,
    content_hash text,
    raw_payload_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT orders_buy_type_check CHECK ((buy_type = ANY (ARRAY['self'::text, 'share'::text]))),
    CONSTRAINT orders_diff_reason_check CHECK ((diff_reason_code = ANY (ARRAY['PART_REFUND'::text, 'PRICE_COMPARE'::text, 'PRICE_PROTECT'::text, 'SETTLE_DIFF'::text]))),
    CONSTRAINT orders_hold_reason_check CHECK ((hold_reason = ANY (ARRAY['RISK'::text, 'CS'::text, 'UNMAPPED_STATUS'::text]))),
    CONSTRAINT orders_platform_status_check CHECK ((platform_status = ANY (ARRAY['DEPOSIT_PAID'::text, 'PAID'::text, 'RECEIVED'::text, 'SETTLED'::text, 'INVALID'::text]))),
    CONSTRAINT orders_reason_check CHECK ((reason = ANY (ARRAY['REFUND'::text, 'RIGHTS'::text, 'PUNISH'::text, 'PRESALE_UNPAID'::text, 'COMMISSION_ZERO'::text, 'OTHER'::text, 'BLACKLIST'::text, 'PART_REFUND'::text, 'PRICE_COMPARE'::text, 'PRICE_PROTECT'::text, 'SETTLE_DIFF'::text]))),
    CONSTRAINT orders_rebate_status_check CHECK ((rebate_status = ANY (ARRAY['UNATTRIBUTED'::text, 'ESTIMATED'::text, 'WAITING'::text, 'CREDITED'::text, 'VOID'::text, 'CLAWED_BACK'::text]))),
    CONSTRAINT orders_scene_basis_check CHECK ((scene_basis = ANY (ARRAY['pid'::text, 'param'::text, 'fallback'::text]))),
    CONSTRAINT orders_settle_period_check CHECK ((settle_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT orders_source_match_check CHECK ((source_match = ANY (ARRAY['exact'::text, 'product'::text, 'shop'::text, 'none'::text]))),
    CONSTRAINT orders_user_basis_check CHECK ((user_basis = ANY (ARRAY['param'::text, 'claim'::text, 'admin'::text])))
)
PARTITION BY RANGE (attr_at);


--
-- Name: orders_default; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.orders_default (
    order_id uuid CONSTRAINT orders_order_id_not_null NOT NULL,
    app_id text CONSTRAINT orders_app_id_not_null NOT NULL,
    platform text CONSTRAINT orders_platform_not_null NOT NULL,
    sub_order_id text CONSTRAINT orders_sub_order_id_not_null NOT NULL,
    parent_order_id text,
    shop_type text,
    product_key text,
    raw_item_id text CONSTRAINT orders_raw_item_id_not_null NOT NULL,
    shop_id text,
    title text,
    image_url text,
    quantity integer,
    refunded_quantity integer,
    refunded_quantity_at_credit integer,
    pay_amount_fen bigint,
    pid text,
    relation_id text,
    sub_union_id text,
    custom_params text,
    link_id uuid,
    source_match text,
    user_id uuid,
    buy_type text,
    scene_basis text,
    user_basis text,
    platform_status text CONSTRAINT orders_platform_status_not_null NOT NULL,
    rebate_status text DEFAULT 'UNATTRIBUTED'::text CONSTRAINT orders_rebate_status_not_null NOT NULL,
    hold boolean DEFAULT false CONSTRAINT orders_hold_not_null NOT NULL,
    hold_reason text,
    rights_pending boolean DEFAULT false CONSTRAINT orders_rights_pending_not_null NOT NULL,
    locked boolean DEFAULT false CONSTRAINT orders_locked_not_null NOT NULL,
    row_version integer DEFAULT 0 CONSTRAINT orders_row_version_not_null NOT NULL,
    commission_version integer DEFAULT 0 CONSTRAINT orders_commission_version_not_null NOT NULL,
    reason text,
    reason_sub text,
    diff_reason_code text,
    is_presale boolean DEFAULT false CONSTRAINT orders_is_presale_not_null NOT NULL,
    deposit_paid_at timestamp with time zone,
    paid_at timestamp with time zone,
    paid_at_source text,
    attr_at timestamp with time zone CONSTRAINT orders_attr_at_not_null NOT NULL,
    received_at timestamp with time zone,
    platform_received_at timestamp with time zone,
    received_synced_at timestamp with time zone,
    settled_at timestamp with time zone,
    union_settled_at timestamp with time zone,
    settle_period text,
    platform_modified_at timestamp with time zone,
    credit_requires_settle boolean DEFAULT false CONSTRAINT orders_credit_requires_settle_not_null NOT NULL,
    credited_at timestamp with time zone,
    est_commission_fen bigint,
    settle_commission_fen bigint,
    subsidy_commission_fen bigint,
    booked_base_fen bigint,
    booked_n_fen bigint,
    initial_est_fen bigint,
    n_total_fen bigint,
    pre_base_deduct_fen bigint,
    base_fen bigint,
    platform_est_profit_fen bigint,
    commission_rate_bp integer,
    is_price_compare boolean,
    commission_rate_min_bp integer,
    commission_rate_max_bp integer,
    activity_type text,
    source_scene text,
    agent_session_id uuid,
    content_hash text,
    raw_payload_id bigint,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT orders_created_at_not_null NOT NULL,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT orders_updated_at_not_null NOT NULL,
    CONSTRAINT orders_buy_type_check CHECK ((buy_type = ANY (ARRAY['self'::text, 'share'::text]))),
    CONSTRAINT orders_diff_reason_check CHECK ((diff_reason_code = ANY (ARRAY['PART_REFUND'::text, 'PRICE_COMPARE'::text, 'PRICE_PROTECT'::text, 'SETTLE_DIFF'::text]))),
    CONSTRAINT orders_hold_reason_check CHECK ((hold_reason = ANY (ARRAY['RISK'::text, 'CS'::text, 'UNMAPPED_STATUS'::text]))),
    CONSTRAINT orders_platform_status_check CHECK ((platform_status = ANY (ARRAY['DEPOSIT_PAID'::text, 'PAID'::text, 'RECEIVED'::text, 'SETTLED'::text, 'INVALID'::text]))),
    CONSTRAINT orders_reason_check CHECK ((reason = ANY (ARRAY['REFUND'::text, 'RIGHTS'::text, 'PUNISH'::text, 'PRESALE_UNPAID'::text, 'COMMISSION_ZERO'::text, 'OTHER'::text, 'BLACKLIST'::text, 'PART_REFUND'::text, 'PRICE_COMPARE'::text, 'PRICE_PROTECT'::text, 'SETTLE_DIFF'::text]))),
    CONSTRAINT orders_rebate_status_check CHECK ((rebate_status = ANY (ARRAY['UNATTRIBUTED'::text, 'ESTIMATED'::text, 'WAITING'::text, 'CREDITED'::text, 'VOID'::text, 'CLAWED_BACK'::text]))),
    CONSTRAINT orders_scene_basis_check CHECK ((scene_basis = ANY (ARRAY['pid'::text, 'param'::text, 'fallback'::text]))),
    CONSTRAINT orders_settle_period_check CHECK ((settle_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text)),
    CONSTRAINT orders_source_match_check CHECK ((source_match = ANY (ARRAY['exact'::text, 'product'::text, 'shop'::text, 'none'::text]))),
    CONSTRAINT orders_user_basis_check CHECK ((user_basis = ANY (ARRAY['param'::text, 'claim'::text, 'admin'::text])))
);


--
-- Name: payout_account_changes; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.payout_account_changes (
    id bigint NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    old_payout_method text NOT NULL,
    new_payout_method text NOT NULL,
    old_hmac text NOT NULL,
    new_hmac text NOT NULL,
    operator text NOT NULL,
    changed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payout_account_changes_new_method_check CHECK ((new_payout_method = ANY (ARRAY['alipay'::text, 'bank_card'::text]))),
    CONSTRAINT payout_account_changes_old_method_check CHECK ((old_payout_method = ANY (ARRAY['alipay'::text, 'bank_card'::text])))
);


--
-- Name: payout_account_changes_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.payout_account_changes ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.payout_account_changes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: payout_account_verify_attempts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.payout_account_verify_attempts (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    verify_date date NOT NULL,
    status text NOT NULL,
    vendor_request_id text NOT NULL,
    request_fingerprint text NOT NULL,
    reserved_at timestamp with time zone NOT NULL,
    unknown_at timestamp with time zone,
    resolved_at timestamp with time zone,
    origin_action text NOT NULL,
    idempotency_key text,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payout_account_verify_attempts_action_check CHECK ((origin_action = 'payout_account_change'::text)),
    CONSTRAINT payout_account_verify_attempts_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'matched'::text, 'mismatched'::text, 'unknown'::text, 'expired_unresolved'::text, 'released'::text])))
);


--
-- Name: payout_accounts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.payout_accounts (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    payout_method text NOT NULL,
    alipay_logon_id_cipher bytea,
    alipay_hmac text,
    bank_card_no_cipher bytea,
    bank_card_hmac text,
    bank_name text,
    card_bin text,
    payee_name text NOT NULL,
    is_current boolean NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payout_accounts_details_check CHECK ((((payout_method = 'alipay'::text) AND (alipay_logon_id_cipher IS NOT NULL) AND (alipay_hmac IS NOT NULL) AND (bank_card_no_cipher IS NULL) AND (bank_card_hmac IS NULL) AND (bank_name IS NULL) AND (card_bin IS NULL)) OR ((payout_method = 'bank_card'::text) AND (bank_card_no_cipher IS NOT NULL) AND (bank_card_hmac IS NOT NULL) AND (bank_name IS NOT NULL) AND (card_bin IS NOT NULL) AND (alipay_logon_id_cipher IS NULL) AND (alipay_hmac IS NULL)))),
    CONSTRAINT payout_accounts_method_check CHECK ((payout_method = ANY (ARRAY['alipay'::text, 'bank_card'::text])))
);


--
-- Name: platforms; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.platforms (
    code text NOT NULL,
    key_prefix text,
    key_stability text NOT NULL,
    search_support text NOT NULL,
    convert_support text NOT NULL,
    order_sync_support text NOT NULL,
    stage text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platforms_code_check CHECK ((code ~ '^[a-z][a-z0-9_]*$'::text)),
    CONSTRAINT platforms_convert_support_check CHECK ((convert_support = ANY (ARRAY['supported'::text, 'unverified'::text, 'activity'::text, 'p1'::text, 'p2'::text, 'none'::text]))),
    CONSTRAINT platforms_key_prefix_check CHECK ((key_prefix ~ '^[a-z0-9]+$'::text)),
    CONSTRAINT platforms_key_stability_check CHECK ((key_stability = ANY (ARRAY['unverified'::text, 'stable_24h'::text, 'stable_7d'::text, 'unstable'::text]))),
    CONSTRAINT platforms_order_sync_support_check CHECK ((order_sync_support = ANY (ARRAY['supported'::text, 'unverified'::text, 'activity'::text, 'p1'::text, 'p2'::text, 'none'::text]))),
    CONSTRAINT platforms_search_support_check CHECK ((search_support = ANY (ARRAY['supported'::text, 'unverified'::text, 'activity'::text, 'p1'::text, 'p2'::text, 'none'::text]))),
    CONSTRAINT platforms_stage_check CHECK ((stage = ANY (ARRAY['m_beta'::text, 'p1'::text, 'p2'::text])))
);


--
-- Name: processed_events; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.processed_events (
    consumer text NOT NULL,
    event_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: product_key_aliases; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.product_key_aliases (
    old_key text NOT NULL,
    new_key text NOT NULL,
    reason text NOT NULL,
    adr_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_key_aliases_adr_id_check CHECK ((adr_id <> ''::text)),
    CONSTRAINT product_key_aliases_distinct_check CHECK ((old_key <> new_key)),
    CONSTRAINT product_key_aliases_new_key_check CHECK (((char_length(new_key) <= 128) AND (new_key ~ '^[a-z0-9]+:[!-"$-.0->@-~]{1,124}$'::text))),
    CONSTRAINT product_key_aliases_old_key_check CHECK (((char_length(old_key) <= 128) AND (old_key ~ '^[a-z0-9]+:[!-"$-.0->@-~]{1,124}$'::text))),
    CONSTRAINT product_key_aliases_reason_check CHECK ((reason <> ''::text))
);


--
-- Name: product_refs; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.product_refs (
    app_id text NOT NULL,
    product_key text NOT NULL,
    platform text NOT NULL,
    raw_item_id text NOT NULL,
    raw_fetched_at timestamp with time zone NOT NULL,
    canonical_url text,
    title text NOT NULL,
    shop_id text,
    shop_type text,
    source text NOT NULL,
    refreshed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_refs_product_key_check CHECK (((char_length(product_key) <= 128) AND (product_key ~ '^[a-z0-9]+:[!-"$-.0->@-~]{1,124}$'::text))),
    CONSTRAINT product_refs_raw_item_id_check CHECK ((raw_item_id <> ''::text)),
    CONSTRAINT product_refs_source_check CHECK ((source = ANY (ARRAY['search'::text, 'detail'::text, 'parse'::text, 'pool'::text])))
);


--
-- Name: push_tokens; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.push_tokens (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    bound_sid text,
    device_id uuid NOT NULL,
    provider text NOT NULL,
    token text NOT NULL,
    token_set_at timestamp with time zone NOT NULL,
    acquired_by_move_at timestamp with time zone,
    frozen_until timestamp with time zone,
    revoked_at timestamp with time zone,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.refresh_tokens (
    id uuid NOT NULL,
    app_id text NOT NULL,
    sid text NOT NULL,
    token_hash text NOT NULL,
    parent_hash text,
    rotated_at timestamp with time zone,
    expire_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: risk_hits; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.risk_hits (
    id bigint NOT NULL,
    app_id text NOT NULL,
    user_id uuid,
    rule_id text NOT NULL,
    risk_action text NOT NULL,
    dimension text NOT NULL,
    value_hmac text NOT NULL,
    ref_type text NOT NULL,
    ref_id text NOT NULL,
    request_type text,
    related_phone_hmac text,
    related_phone_masked text,
    amount_fen bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT risk_hits_amount_check CHECK (
CASE
    WHEN (request_type = 'withdraw'::text) THEN ((amount_fen IS NOT NULL) AND (amount_fen > 0))
    ELSE (amount_fen IS NULL)
END),
    CONSTRAINT risk_hits_ref_type_check CHECK ((ref_type = ANY (ARRAY['order'::text, 'withdrawal'::text, 'blocked_request'::text]))),
    CONSTRAINT risk_hits_related_phone_check CHECK (
CASE
    WHEN (request_type = ANY (ARRAY['register'::text, 'phone_change'::text])) THEN ((related_phone_hmac IS NOT NULL) AND (related_phone_masked IS NOT NULL))
    WHEN (ref_type <> 'blocked_request'::text) THEN ((related_phone_hmac IS NULL) AND (related_phone_masked IS NULL))
    ELSE ((related_phone_hmac IS NULL) = (related_phone_masked IS NULL))
END),
    CONSTRAINT risk_hits_request_check CHECK (((request_type IS NULL) OR (ref_type = 'blocked_request'::text))),
    CONSTRAINT risk_hits_request_type_check CHECK ((request_type = ANY (ARRAY['register'::text, 'withdraw'::text, 'phone_change'::text, 'payout_account'::text]))),
    CONSTRAINT risk_hits_risk_action_check CHECK ((risk_action = ANY (ARRAY['pass'::text, 'manual_review'::text, 'block'::text, 'void_commission'::text]))),
    CONSTRAINT risk_hits_user_check CHECK (
CASE
    WHEN (request_type = 'register'::text) THEN (user_id IS NULL)
    WHEN (request_type IS NOT NULL) THEN (user_id IS NOT NULL)
    ELSE true
END)
);


--
-- Name: risk_hits_id_seq; Type: SEQUENCE; Schema: app; Owner: -
--

ALTER TABLE app.risk_hits ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME app.risk_hits_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: risk_rules; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.risk_rules (
    id uuid NOT NULL,
    app_id text NOT NULL,
    rule_id text NOT NULL,
    scene text NOT NULL,
    conditions jsonb NOT NULL,
    risk_action text NOT NULL,
    status text NOT NULL,
    version integer NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT risk_rules_risk_action_check CHECK ((risk_action = ANY (ARRAY['pass'::text, 'manual_review'::text, 'block'::text, 'void_commission'::text])))
);


--
-- Name: sessions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.sessions (
    id uuid NOT NULL,
    app_id text NOT NULL,
    sid text NOT NULL,
    user_id uuid NOT NULL,
    device_id uuid NOT NULL,
    revoked_at timestamp with time zone,
    revoke_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: union_accounts; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.union_accounts (
    id uuid NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    account_name text NOT NULL,
    status text NOT NULL,
    sync_start_at timestamp with time zone,
    auth_expires_at timestamp with time zone,
    auth_status text NOT NULL,
    auth_renewed_at timestamp with time zone,
    auth_renewed_by uuid,
    alert_stage text DEFAULT 'none'::text NOT NULL,
    last_probe_at timestamp with time zone,
    last_probe_ok boolean,
    last_probe_error text,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT union_accounts_alert_stage_check CHECK ((alert_stage = ANY (ARRAY['none'::text, 'd14'::text, 'd7'::text, 'd1'::text, 'expired'::text]))),
    CONSTRAINT union_accounts_auth_status_check CHECK ((auth_status = ANY (ARRAY['active'::text, 'expiring'::text, 'expired'::text])))
);


--
-- Name: union_auth_sessions; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.union_auth_sessions (
    state text NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    device_id uuid NOT NULL,
    platform text NOT NULL,
    mode text NOT NULL,
    link_id uuid,
    expire_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    client text NOT NULL,
    auth_methods text[],
    auth_app_refs jsonb,
    CONSTRAINT union_auth_sessions_auth_app_refs_check CHECK (((auth_app_refs IS NULL) OR
CASE
    WHEN ((auth_methods IS NOT NULL) AND (jsonb_typeof(auth_app_refs) = 'object'::text)) THEN ((auth_app_refs ?& auth_methods) AND ((auth_app_refs - auth_methods) = '{}'::jsonb) AND ((NOT (auth_app_refs ? 'web_code'::text)) OR ((jsonb_typeof((auth_app_refs -> 'web_code'::text)) = 'string'::text) AND ((auth_app_refs ->> 'web_code'::text) <> ''::text))) AND ((NOT (auth_app_refs ? 'sdk_token'::text)) OR ((jsonb_typeof((auth_app_refs -> 'sdk_token'::text)) = 'string'::text) AND ((auth_app_refs ->> 'sdk_token'::text) <> ''::text))))
    ELSE false
END)),
    CONSTRAINT union_auth_sessions_auth_app_refs_presence_check CHECK (((auth_app_refs IS NULL) = (auth_methods IS NULL))),
    CONSTRAINT union_auth_sessions_auth_methods_check CHECK (((auth_methods IS NULL) OR
CASE
    WHEN ((array_ndims(auth_methods) = 1) AND (array_lower(auth_methods, 1) = 1) AND (array_position(auth_methods, NULL::text) IS NULL) AND (auth_methods <@ ARRAY['web_code'::text, 'sdk_token'::text])) THEN ((cardinality(auth_methods) = 1) OR ((cardinality(auth_methods) = 2) AND (auth_methods[1] <> auth_methods[2])))
    ELSE false
END)),
    CONSTRAINT union_auth_sessions_auth_methods_platform_check CHECK (((platform = 'taobao'::text) = (auth_methods IS NOT NULL))),
    CONSTRAINT union_auth_sessions_client_check CHECK ((client = ANY (ARRAY['ios'::text, 'android'::text, 'harmony'::text]))),
    CONSTRAINT union_auth_sessions_mode_check CHECK ((mode = 'bind'::text))
);


--
-- Name: union_bindings; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.union_bindings (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    platform text NOT NULL,
    union_account_id uuid NOT NULL,
    relation_id text,
    special_id text,
    pdd_custom text,
    status text NOT NULL,
    bound_at timestamp with time zone,
    released_at timestamp with time zone,
    cooldown_until timestamp with time zone,
    blocked_reason text,
    reason text,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT union_bindings_blocked_reason_check CHECK ((blocked_reason = ANY (ARRAY['ban'::text, 'admin_disable'::text, 'deletion'::text]))),
    CONSTRAINT union_bindings_cooldown_order_check CHECK ((cooldown_until >= released_at)),
    CONSTRAINT union_bindings_release_pair_check CHECK (((released_at IS NULL) = (cooldown_until IS NULL))),
    CONSTRAINT union_bindings_released_instants_check CHECK (((status <> 'released'::text) OR (released_at IS NOT NULL))),
    CONSTRAINT union_bindings_status_check CHECK ((status = ANY (ARRAY['unbound'::text, 'pending_auth'::text, 'active'::text, 'invalid'::text, 'released'::text, 'blocked'::text])))
);


--
-- Name: union_credentials; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.union_credentials (
    id uuid NOT NULL,
    app_id text NOT NULL,
    union_account_id uuid NOT NULL,
    access_token_cipher bytea NOT NULL,
    refresh_token_cipher bytea,
    expires_at timestamp with time zone,
    is_current boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: union_pids; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.union_pids (
    id uuid NOT NULL,
    app_id text NOT NULL,
    platform text NOT NULL,
    union_account_id uuid NOT NULL,
    site_id text,
    pid text NOT NULL,
    pid_scene text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    hjy_ignore_confirmed_at timestamp with time zone,
    hjy_ignore_evidence_path text,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT union_pids_hjy_evidence_check CHECK (((status = 'pending'::text) OR ((hjy_ignore_confirmed_at IS NOT NULL) AND (hjy_ignore_evidence_path IS NOT NULL)))),
    CONSTRAINT union_pids_pid_scene_check CHECK ((pid_scene = ANY (ARRAY['self_buy'::text, 'agent'::text, 'share'::text, 'taolijin'::text, 'fallback'::text, 'query'::text]))),
    CONSTRAINT union_pids_site_check CHECK (((platform = 'taobao'::text) = (site_id IS NOT NULL))),
    CONSTRAINT union_pids_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'retired'::text])))
);


--
-- Name: user_oauth; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.user_oauth (
    id uuid NOT NULL,
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    union_id text NOT NULL,
    open_id text,
    merged_from_user_id uuid,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_oauth_provider_check CHECK ((provider = ANY (ARRAY['wechat'::text, 'apple'::text, 'huawei'::text])))
);


--
-- Name: user_risk_state; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.user_risk_state (
    user_id uuid NOT NULL,
    app_id text NOT NULL,
    state text NOT NULL,
    reason text,
    reason_category text,
    frozen_until timestamp with time zone,
    changed_by text NOT NULL,
    changed_at timestamp with time zone NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_risk_state_frozen_until_check CHECK (((frozen_until IS NULL) OR (state = ANY (ARRAY['frozen'::text, 'appealing'::text])))),
    CONSTRAINT user_risk_state_reason_category_check CHECK ((reason_category = ANY (ARRAY['malicious_rights'::text, 'fraud_invite'::text, 'abnormal_trade'::text, 'account_security'::text, 'other'::text]))),
    CONSTRAINT user_risk_state_reason_category_required_check CHECK (((state = 'normal'::text) OR (reason_category IS NOT NULL))),
    CONSTRAINT user_risk_state_state_check CHECK ((state = ANY (ARRAY['normal'::text, 'frozen'::text, 'appealing'::text, 'banned'::text])))
);


--
-- Name: user_tip_reads; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.user_tip_reads (
    app_id text NOT NULL,
    user_id uuid NOT NULL,
    tip_key text NOT NULL,
    platform text NOT NULL,
    read_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_tip_reads_tip_key_check CHECK ((tip_key = ANY (ARRAY['jump_tip'::text, 'inviter_before_buy'::text])))
);


--
-- Name: users; Type: TABLE; Schema: app; Owner: -
--

CREATE TABLE app.users (
    id uuid NOT NULL,
    app_id text NOT NULL,
    phone_cipher bytea,
    phone_hmac text,
    nickname text NOT NULL,
    avatar text NOT NULL,
    nickname_change_month text,
    nickname_change_count integer DEFAULT 0 NOT NULL,
    invite_code text NOT NULL,
    attr_code text NOT NULL,
    parent_id uuid,
    parent_bind_source text,
    parent_bound_at timestamp with time zone,
    self_bind_used boolean DEFAULT false NOT NULL,
    level text NOT NULL,
    status text DEFAULT 'normal'::text NOT NULL,
    row_version integer DEFAULT 0 NOT NULL,
    deleted_reason text,
    personalization_off boolean DEFAULT false NOT NULL,
    register_method text NOT NULL,
    registered_channel text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_nickname_change_month_check CHECK ((nickname_change_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'::text))
);


--
-- Name: bam; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.bam (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    version integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    queue text,
    table_name text NOT NULL,
    command text NOT NULL,
    error text,
    created_on timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    started_on timestamp with time zone,
    completed_on timestamp with time zone
);


--
-- Name: job; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.job (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    data jsonb,
    state pgboss.job_state DEFAULT 'created'::pgboss.job_state NOT NULL,
    retry_limit integer DEFAULT 2 NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    retry_delay integer DEFAULT 0 NOT NULL,
    retry_backoff boolean DEFAULT false NOT NULL,
    retry_delay_max integer,
    expire_seconds integer DEFAULT 900 NOT NULL,
    deletion_seconds integer DEFAULT 604800 NOT NULL,
    singleton_key text,
    singleton_on timestamp without time zone,
    group_id text,
    group_tier text,
    start_after timestamp with time zone DEFAULT now() NOT NULL,
    created_on timestamp with time zone DEFAULT now() NOT NULL,
    started_on timestamp with time zone,
    completed_on timestamp with time zone,
    keep_until timestamp with time zone DEFAULT (now() + '336:00:00'::interval) NOT NULL,
    output jsonb,
    dead_letter text,
    policy text,
    heartbeat_on timestamp with time zone,
    heartbeat_seconds integer,
    blocked boolean DEFAULT false NOT NULL,
    blocking boolean DEFAULT false NOT NULL,
    pending_dependencies integer DEFAULT 0 NOT NULL,
    source_name text,
    source_id uuid,
    source_created_on timestamp with time zone,
    source_retry_count integer
)
PARTITION BY LIST (name);


--
-- Name: job_common; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.job_common (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT job_id_not_null NOT NULL,
    name text CONSTRAINT job_name_not_null NOT NULL,
    priority integer DEFAULT 0 CONSTRAINT job_priority_not_null NOT NULL,
    data jsonb,
    state pgboss.job_state DEFAULT 'created'::pgboss.job_state CONSTRAINT job_state_not_null NOT NULL,
    retry_limit integer DEFAULT 2 CONSTRAINT job_retry_limit_not_null NOT NULL,
    retry_count integer DEFAULT 0 CONSTRAINT job_retry_count_not_null NOT NULL,
    retry_delay integer DEFAULT 0 CONSTRAINT job_retry_delay_not_null NOT NULL,
    retry_backoff boolean DEFAULT false CONSTRAINT job_retry_backoff_not_null NOT NULL,
    retry_delay_max integer,
    expire_seconds integer DEFAULT 900 CONSTRAINT job_expire_seconds_not_null NOT NULL,
    deletion_seconds integer DEFAULT 604800 CONSTRAINT job_deletion_seconds_not_null NOT NULL,
    singleton_key text,
    singleton_on timestamp without time zone,
    group_id text,
    group_tier text,
    start_after timestamp with time zone DEFAULT now() CONSTRAINT job_start_after_not_null NOT NULL,
    created_on timestamp with time zone DEFAULT now() CONSTRAINT job_created_on_not_null NOT NULL,
    started_on timestamp with time zone,
    completed_on timestamp with time zone,
    keep_until timestamp with time zone DEFAULT (now() + '336:00:00'::interval) CONSTRAINT job_keep_until_not_null NOT NULL,
    output jsonb,
    dead_letter text,
    policy text,
    heartbeat_on timestamp with time zone,
    heartbeat_seconds integer,
    blocked boolean DEFAULT false CONSTRAINT job_blocked_not_null NOT NULL,
    blocking boolean DEFAULT false CONSTRAINT job_blocking_not_null NOT NULL,
    pending_dependencies integer DEFAULT 0 CONSTRAINT job_pending_dependencies_not_null NOT NULL,
    source_name text,
    source_id uuid,
    source_created_on timestamp with time zone,
    source_retry_count integer,
    CONSTRAINT job_key_strict_fifo_singleton_key_check CHECK ((NOT ((policy = 'key_strict_fifo'::text) AND (singleton_key IS NULL))))
);


--
-- Name: job_dependency; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.job_dependency (
    child_name text NOT NULL,
    child_id uuid NOT NULL,
    parent_name text NOT NULL,
    parent_id uuid NOT NULL
);


--
-- Name: queue; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.queue (
    name text NOT NULL,
    policy text NOT NULL,
    retry_limit integer NOT NULL,
    retry_delay integer NOT NULL,
    retry_backoff boolean NOT NULL,
    retry_delay_max integer,
    expire_seconds integer NOT NULL,
    retention_seconds integer NOT NULL,
    deletion_seconds integer NOT NULL,
    dead_letter text,
    partition boolean NOT NULL,
    table_name text NOT NULL,
    deferred_count integer DEFAULT 0 NOT NULL,
    queued_count integer DEFAULT 0 NOT NULL,
    ready_count integer DEFAULT 0 NOT NULL,
    warning_queued integer DEFAULT 0 NOT NULL,
    active_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    ready_history integer[] DEFAULT '{}'::integer[] NOT NULL,
    heartbeat_seconds integer,
    notify boolean DEFAULT false NOT NULL,
    singletons_active text[],
    monitor_claim_on timestamp with time zone,
    monitor_on timestamp with time zone,
    maintain_on timestamp with time zone,
    created_on timestamp with time zone DEFAULT now() NOT NULL,
    updated_on timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT queue_check CHECK ((dead_letter IS DISTINCT FROM name))
);


--
-- Name: queue_stats; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.queue_stats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    deferred_count integer DEFAULT 0 NOT NULL,
    queued_count integer DEFAULT 0 NOT NULL,
    ready_count integer DEFAULT 0 NOT NULL,
    active_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    captured_on timestamp with time zone DEFAULT now() NOT NULL
)
PARTITION BY RANGE (captured_on);


--
-- Name: schedule; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.schedule (
    name text NOT NULL,
    key text DEFAULT ''::text NOT NULL,
    kind text DEFAULT 'cron'::text NOT NULL,
    cron text NOT NULL,
    timezone text DEFAULT 'UTC'::text,
    data jsonb,
    options jsonb,
    created_on timestamp with time zone DEFAULT now() NOT NULL,
    updated_on timestamp with time zone DEFAULT now() NOT NULL,
    last_job_id uuid,
    CONSTRAINT schedule_kind_check CHECK ((kind = ANY (ARRAY['cron'::text, 'rrule'::text])))
);


--
-- Name: subscription; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.subscription (
    event text NOT NULL,
    name text NOT NULL,
    created_on timestamp with time zone DEFAULT now() NOT NULL,
    updated_on timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: version; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.version (
    version integer NOT NULL,
    cron_on timestamp with time zone,
    bam_on timestamp with time zone,
    flow_on timestamp with time zone,
    reindex_on timestamp with time zone,
    monitor_backoff_on timestamp with time zone
);


--
-- Name: warning; Type: TABLE; Schema: pgboss; Owner: -
--

CREATE TABLE pgboss.warning (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text NOT NULL,
    message text NOT NULL,
    data jsonb,
    created_on timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pgmigrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pgmigrations (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    run_on timestamp without time zone NOT NULL
);


--
-- Name: pgmigrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pgmigrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pgmigrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pgmigrations_id_seq OWNED BY public.pgmigrations.id;


--
-- Name: event_log_default; Type: TABLE ATTACH; Schema: app; Owner: -
--

ALTER TABLE ONLY app.event_log ATTACH PARTITION app.event_log_default DEFAULT;


--
-- Name: link_logs_default; Type: TABLE ATTACH; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_logs ATTACH PARTITION app.link_logs_default DEFAULT;


--
-- Name: orders_default; Type: TABLE ATTACH; Schema: app; Owner: -
--

ALTER TABLE ONLY app.orders ATTACH PARTITION app.orders_default DEFAULT;


--
-- Name: job_common; Type: TABLE ATTACH; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job ATTACH PARTITION pgboss.job_common DEFAULT;


--
-- Name: pgmigrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pgmigrations ALTER COLUMN id SET DEFAULT nextval('public.pgmigrations_id_seq'::regclass);


--
-- Name: admin_permissions admin_permissions_admin_permission_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_permissions
    ADD CONSTRAINT admin_permissions_admin_permission_key UNIQUE (app_id, admin_id, permission_key);


--
-- Name: admin_permissions admin_permissions_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_permissions
    ADD CONSTRAINT admin_permissions_pkey PRIMARY KEY (id);


--
-- Name: admin_users admin_users_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_users
    ADD CONSTRAINT admin_users_app_id_id_key UNIQUE (app_id, id);


--
-- Name: admin_users admin_users_login_name_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_users
    ADD CONSTRAINT admin_users_login_name_key UNIQUE (login_name);


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (id);


--
-- Name: agent_cards agent_cards_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_cards
    ADD CONSTRAINT agent_cards_pkey PRIMARY KEY (id);


--
-- Name: agent_cards agent_cards_session_card_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_cards
    ADD CONSTRAINT agent_cards_session_card_key UNIQUE (app_id, session_id, card_id);


--
-- Name: agent_messages agent_messages_client_msg_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_messages
    ADD CONSTRAINT agent_messages_client_msg_key UNIQUE (app_id, session_id, client_msg_id);


--
-- Name: agent_messages agent_messages_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_messages
    ADD CONSTRAINT agent_messages_pkey PRIMARY KEY (id);


--
-- Name: agent_result_sets agent_result_sets_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_result_sets
    ADD CONSTRAINT agent_result_sets_pkey PRIMARY KEY (id);


--
-- Name: agent_runs agent_runs_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_runs
    ADD CONSTRAINT agent_runs_app_id_id_key UNIQUE (app_id, id);


--
-- Name: agent_runs agent_runs_app_id_session_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_runs
    ADD CONSTRAINT agent_runs_app_id_session_id_id_key UNIQUE (app_id, session_id, id);


--
-- Name: agent_runs agent_runs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_runs
    ADD CONSTRAINT agent_runs_pkey PRIMARY KEY (id);


--
-- Name: agent_sessions agent_sessions_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_sessions
    ADD CONSTRAINT agent_sessions_app_id_id_key UNIQUE (app_id, id);


--
-- Name: agent_sessions agent_sessions_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_sessions
    ADD CONSTRAINT agent_sessions_pkey PRIMARY KEY (id);


--
-- Name: agent_tool_calls agent_tool_calls_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_tool_calls
    ADD CONSTRAINT agent_tool_calls_pkey PRIMARY KEY (id);


--
-- Name: agent_tool_calls agent_tool_calls_run_seq_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_tool_calls
    ADD CONSTRAINT agent_tool_calls_run_seq_key UNIQUE (app_id, run_id, seq);


--
-- Name: app_versions app_versions_app_platform_channel_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.app_versions
    ADD CONSTRAINT app_versions_app_platform_channel_key UNIQUE (app_id, platform, channel);


--
-- Name: app_versions app_versions_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.app_versions
    ADD CONSTRAINT app_versions_pkey PRIMARY KEY (id);


--
-- Name: appeals appeals_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.appeals
    ADD CONSTRAINT appeals_pkey PRIMARY KEY (id);


--
-- Name: articles articles_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.articles
    ADD CONSTRAINT articles_pkey PRIMARY KEY (id, version);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: blocklist blocklist_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.blocklist
    ADD CONSTRAINT blocklist_pkey PRIMARY KEY (id);


--
-- Name: category_blocklist category_blocklist_entry_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.category_blocklist
    ADD CONSTRAINT category_blocklist_entry_key UNIQUE NULLS NOT DISTINCT (app_id, platform, category_id, keyword);


--
-- Name: category_blocklist category_blocklist_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.category_blocklist
    ADD CONSTRAINT category_blocklist_pkey PRIMARY KEY (id);


--
-- Name: config_items config_items_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.config_items
    ADD CONSTRAINT config_items_pkey PRIMARY KEY (app_id, key);


--
-- Name: consent_records consent_records_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.consent_records
    ADD CONSTRAINT consent_records_pkey PRIMARY KEY (id);


--
-- Name: device_registrations device_registrations_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.device_registrations
    ADD CONSTRAINT device_registrations_pkey PRIMARY KEY (app_id, user_id);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: event_log event_log_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.event_log
    ADD CONSTRAINT event_log_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: event_log_default event_log_default_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.event_log_default
    ADD CONSTRAINT event_log_default_pkey PRIMARY KEY (id, occurred_at);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id);


--
-- Name: idempotency_keys idempotency_keys_scope_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.idempotency_keys
    ADD CONSTRAINT idempotency_keys_scope_key UNIQUE (app_id, subject, method, path, key);


--
-- Name: inbox_messages inbox_messages_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.inbox_messages
    ADD CONSTRAINT inbox_messages_pkey PRIMARY KEY (message_id);


--
-- Name: link_logs link_logs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_logs
    ADD CONSTRAINT link_logs_pkey PRIMARY KEY (id, created_at);


--
-- Name: link_logs_default link_logs_default_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_logs_default
    ADD CONSTRAINT link_logs_default_pkey PRIMARY KEY (id, created_at);


--
-- Name: link_open_attempts link_open_attempts_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_open_attempts
    ADD CONSTRAINT link_open_attempts_pkey PRIMARY KEY (attempt_id);


--
-- Name: links links_app_id_link_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.links
    ADD CONSTRAINT links_app_id_link_id_key UNIQUE (app_id, link_id);


--
-- Name: links links_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.links
    ADD CONSTRAINT links_pkey PRIMARY KEY (link_id);


--
-- Name: login_logs login_logs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.login_logs
    ADD CONSTRAINT login_logs_pkey PRIMARY KEY (id);


--
-- Name: order_keys order_keys_app_order_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_keys
    ADD CONSTRAINT order_keys_app_order_key UNIQUE (app_id, order_id);


--
-- Name: order_keys order_keys_identity_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_keys
    ADD CONSTRAINT order_keys_identity_key UNIQUE (order_id, attr_at, app_id, platform, sub_order_id);


--
-- Name: order_keys order_keys_order_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_keys
    ADD CONSTRAINT order_keys_order_id_key UNIQUE (order_id);


--
-- Name: order_keys order_keys_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_keys
    ADD CONSTRAINT order_keys_pkey PRIMARY KEY (platform, sub_order_id);


--
-- Name: order_rights order_rights_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_rights
    ADD CONSTRAINT order_rights_pkey PRIMARY KEY (id);


--
-- Name: order_settlements order_settlements_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_settlements
    ADD CONSTRAINT order_settlements_pkey PRIMARY KEY (order_id, seq);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (order_id, attr_at);


--
-- Name: orders_default orders_default_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.orders_default
    ADD CONSTRAINT orders_default_pkey PRIMARY KEY (order_id, attr_at);


--
-- Name: payout_account_changes payout_account_changes_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_account_changes
    ADD CONSTRAINT payout_account_changes_pkey PRIMARY KEY (id);


--
-- Name: payout_account_verify_attempts payout_account_verify_attempts_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_account_verify_attempts
    ADD CONSTRAINT payout_account_verify_attempts_pkey PRIMARY KEY (id);


--
-- Name: payout_account_verify_attempts payout_account_verify_attempts_vendor_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_account_verify_attempts
    ADD CONSTRAINT payout_account_verify_attempts_vendor_key UNIQUE (app_id, vendor_request_id);


--
-- Name: payout_accounts payout_accounts_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_accounts
    ADD CONSTRAINT payout_accounts_pkey PRIMARY KEY (id);


--
-- Name: platforms platforms_key_prefix_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.platforms
    ADD CONSTRAINT platforms_key_prefix_key UNIQUE (key_prefix);


--
-- Name: platforms platforms_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.platforms
    ADD CONSTRAINT platforms_pkey PRIMARY KEY (code);


--
-- Name: processed_events processed_events_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.processed_events
    ADD CONSTRAINT processed_events_pkey PRIMARY KEY (consumer, event_id);


--
-- Name: product_key_aliases product_key_aliases_new_key_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.product_key_aliases
    ADD CONSTRAINT product_key_aliases_new_key_key UNIQUE (new_key);


--
-- Name: product_key_aliases product_key_aliases_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.product_key_aliases
    ADD CONSTRAINT product_key_aliases_pkey PRIMARY KEY (old_key);


--
-- Name: product_refs product_refs_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.product_refs
    ADD CONSTRAINT product_refs_pkey PRIMARY KEY (app_id, product_key);


--
-- Name: push_tokens push_tokens_device_provider_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.push_tokens
    ADD CONSTRAINT push_tokens_device_provider_key UNIQUE (app_id, device_id, provider);


--
-- Name: push_tokens push_tokens_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.push_tokens
    ADD CONSTRAINT push_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_parent_hash_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.refresh_tokens
    ADD CONSTRAINT refresh_tokens_parent_hash_key UNIQUE (app_id, parent_hash);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (app_id, token_hash);


--
-- Name: risk_hits risk_hits_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.risk_hits
    ADD CONSTRAINT risk_hits_pkey PRIMARY KEY (id);


--
-- Name: risk_rules risk_rules_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.risk_rules
    ADD CONSTRAINT risk_rules_pkey PRIMARY KEY (id);


--
-- Name: risk_rules risk_rules_rule_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.risk_rules
    ADD CONSTRAINT risk_rules_rule_id_key UNIQUE (app_id, rule_id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_sid_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.sessions
    ADD CONSTRAINT sessions_sid_key UNIQUE (app_id, sid);


--
-- Name: union_accounts union_accounts_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_accounts
    ADD CONSTRAINT union_accounts_app_id_id_key UNIQUE (app_id, id);


--
-- Name: union_accounts union_accounts_app_id_platform_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_accounts
    ADD CONSTRAINT union_accounts_app_id_platform_id_key UNIQUE (app_id, platform, id);


--
-- Name: union_accounts union_accounts_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_accounts
    ADD CONSTRAINT union_accounts_pkey PRIMARY KEY (id);


--
-- Name: union_auth_sessions union_auth_sessions_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_auth_sessions
    ADD CONSTRAINT union_auth_sessions_pkey PRIMARY KEY (state);


--
-- Name: union_bindings union_bindings_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_bindings
    ADD CONSTRAINT union_bindings_pkey PRIMARY KEY (id);


--
-- Name: union_credentials union_credentials_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_credentials
    ADD CONSTRAINT union_credentials_pkey PRIMARY KEY (id);


--
-- Name: union_pids union_pids_app_platform_pid_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_pids
    ADD CONSTRAINT union_pids_app_platform_pid_key UNIQUE (app_id, platform, pid);


--
-- Name: union_pids union_pids_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_pids
    ADD CONSTRAINT union_pids_pkey PRIMARY KEY (id);


--
-- Name: user_oauth user_oauth_identity_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_oauth
    ADD CONSTRAINT user_oauth_identity_key UNIQUE (app_id, provider, union_id);


--
-- Name: user_oauth user_oauth_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_oauth
    ADD CONSTRAINT user_oauth_pkey PRIMARY KEY (id);


--
-- Name: user_oauth user_oauth_user_provider_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_oauth
    ADD CONSTRAINT user_oauth_user_provider_key UNIQUE (app_id, user_id, provider);


--
-- Name: user_risk_state user_risk_state_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_risk_state
    ADD CONSTRAINT user_risk_state_pkey PRIMARY KEY (user_id);


--
-- Name: user_tip_reads user_tip_reads_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_tip_reads
    ADD CONSTRAINT user_tip_reads_pkey PRIMARY KEY (app_id, user_id, tip_key, platform);


--
-- Name: users users_app_id_id_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_app_id_id_key UNIQUE (app_id, id);


--
-- Name: users users_attr_code_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_attr_code_key UNIQUE (app_id, attr_code);


--
-- Name: users users_invite_code_key; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_invite_code_key UNIQUE (app_id, invite_code);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: bam bam_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.bam
    ADD CONSTRAINT bam_pkey PRIMARY KEY (id);


--
-- Name: job job_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job
    ADD CONSTRAINT job_pkey PRIMARY KEY (name, id);


--
-- Name: job_common job_common_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job_common
    ADD CONSTRAINT job_common_pkey PRIMARY KEY (name, id);


--
-- Name: job_dependency job_dependency_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job_dependency
    ADD CONSTRAINT job_dependency_pkey PRIMARY KEY (child_name, child_id, parent_name, parent_id);


--
-- Name: queue queue_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.queue
    ADD CONSTRAINT queue_pkey PRIMARY KEY (name);


--
-- Name: queue_stats queue_stats_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.queue_stats
    ADD CONSTRAINT queue_stats_pkey PRIMARY KEY (id, captured_on);


--
-- Name: schedule schedule_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.schedule
    ADD CONSTRAINT schedule_pkey PRIMARY KEY (name, key);


--
-- Name: subscription subscription_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.subscription
    ADD CONSTRAINT subscription_pkey PRIMARY KEY (event, name);


--
-- Name: version version_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.version
    ADD CONSTRAINT version_pkey PRIMARY KEY (version);


--
-- Name: warning warning_pkey; Type: CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.warning
    ADD CONSTRAINT warning_pkey PRIMARY KEY (id);


--
-- Name: pgmigrations pgmigrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pgmigrations
    ADD CONSTRAINT pgmigrations_pkey PRIMARY KEY (id);


--
-- Name: admin_permissions_granted_by_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX admin_permissions_granted_by_idx ON app.admin_permissions USING btree (app_id, granted_by);


--
-- Name: agent_cards_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_cards_created_idx ON app.agent_cards USING btree (app_id, created_at);


--
-- Name: agent_cards_run_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_cards_run_idx ON app.agent_cards USING btree (app_id, run_id);


--
-- Name: agent_messages_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_messages_created_idx ON app.agent_messages USING btree (app_id, created_at);


--
-- Name: agent_messages_reported_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_messages_reported_idx ON app.agent_messages USING btree (app_id, report_status, reported_at) WHERE reported;


--
-- Name: agent_messages_run_role_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX agent_messages_run_role_key ON app.agent_messages USING btree (app_id, run_id, role) WHERE (run_id IS NOT NULL);


--
-- Name: agent_messages_session_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_messages_session_created_idx ON app.agent_messages USING btree (app_id, session_id, created_at);


--
-- Name: agent_result_sets_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_result_sets_created_idx ON app.agent_result_sets USING btree (app_id, created_at);


--
-- Name: agent_result_sets_run_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_result_sets_run_idx ON app.agent_result_sets USING btree (app_id, run_id);


--
-- Name: agent_runs_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_runs_created_idx ON app.agent_runs USING btree (app_id, created_at);


--
-- Name: agent_runs_quota_first_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_runs_quota_first_idx ON app.agent_runs USING btree (app_id, (quota_subjects[1]), accepted_at);


--
-- Name: agent_runs_quota_second_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_runs_quota_second_idx ON app.agent_runs USING btree (app_id, (quota_subjects[2]), accepted_at) WHERE (cardinality(quota_subjects) = 2);


--
-- Name: agent_runs_session_accepted_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_runs_session_accepted_idx ON app.agent_runs USING btree (app_id, session_id, accepted_at);


--
-- Name: agent_runs_session_unfinished_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_runs_session_unfinished_idx ON app.agent_runs USING btree (app_id, session_id) WHERE (final_event IS NULL);


--
-- Name: agent_sessions_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_sessions_created_idx ON app.agent_sessions USING btree (app_id, created_at);


--
-- Name: agent_sessions_guest_recent_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_sessions_guest_recent_idx ON app.agent_sessions USING btree (app_id, device_id, last_active_at DESC) WHERE (user_id IS NULL);


--
-- Name: agent_sessions_run_lock_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_sessions_run_lock_idx ON app.agent_sessions USING btree (run_lock_expires_at, id) WHERE (run_lock_run_id IS NOT NULL);


--
-- Name: agent_sessions_user_recent_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_sessions_user_recent_idx ON app.agent_sessions USING btree (app_id, user_id, last_active_at DESC) WHERE (user_id IS NOT NULL);


--
-- Name: agent_tool_calls_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX agent_tool_calls_created_idx ON app.agent_tool_calls USING btree (app_id, created_at);


--
-- Name: appeals_processing_deadline_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX appeals_processing_deadline_idx ON app.appeals USING btree (app_id, deadline_at) WHERE (status = 'processing'::text);


--
-- Name: appeals_processing_register_phone_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX appeals_processing_register_phone_key ON app.appeals USING btree (app_id, related_phone_hmac) WHERE ((status = 'processing'::text) AND (request_type = 'register'::text));


--
-- Name: appeals_processing_target_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX appeals_processing_target_key ON app.appeals USING btree (app_id, target_type, target_id) WHERE (status = 'processing'::text);


--
-- Name: appeals_user_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX appeals_user_idx ON app.appeals USING btree (app_id, user_id, created_at DESC);


--
-- Name: articles_app_category_published_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX articles_app_category_published_idx ON app.articles USING btree (app_id, category, status, published_at, id, version);


--
-- Name: audit_logs_admin_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX audit_logs_admin_at_idx ON app.audit_logs USING btree (app_id, admin_id, at);


--
-- Name: audit_logs_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX audit_logs_at_idx ON app.audit_logs USING btree (app_id, at);


--
-- Name: audit_logs_target_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX audit_logs_target_idx ON app.audit_logs USING btree (app_id, target, at);


--
-- Name: blocklist_value_hmac_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX blocklist_value_hmac_idx ON app.blocklist USING btree (app_id, dimension, value_hmac) WHERE (value_hmac IS NOT NULL);


--
-- Name: blocklist_value_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX blocklist_value_idx ON app.blocklist USING btree (app_id, dimension, value) WHERE (value IS NOT NULL);


--
-- Name: consent_records_device_type_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX consent_records_device_type_idx ON app.consent_records USING btree (app_id, subject_type, device_id, type, server_at DESC);


--
-- Name: consent_records_user_type_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX consent_records_user_type_idx ON app.consent_records USING btree (app_id, subject_type, user_id, type, server_at DESC);


--
-- Name: device_registrations_device_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX device_registrations_device_created_idx ON app.device_registrations USING btree (app_id, device_hash, created_at);


--
-- Name: devices_app_id_id_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX devices_app_id_id_key ON app.devices USING btree (app_id, id);


--
-- Name: event_log_created_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX event_log_created_at_idx ON ONLY app.event_log USING btree (created_at);


--
-- Name: event_log_default_created_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX event_log_default_created_at_idx ON app.event_log_default USING btree (created_at);


--
-- Name: event_log_event_id_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX event_log_event_id_idx ON ONLY app.event_log USING btree (event_id);


--
-- Name: event_log_default_event_id_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX event_log_default_event_id_idx ON app.event_log_default USING btree (event_id);


--
-- Name: inbox_messages_user_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX inbox_messages_user_created_idx ON app.inbox_messages USING btree (app_id, user_id, created_at, message_id);


--
-- Name: link_logs_link_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX link_logs_link_created_idx ON ONLY app.link_logs USING btree (app_id, link_id, created_at);


--
-- Name: link_logs_default_app_id_link_id_created_at_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX link_logs_default_app_id_link_id_created_at_idx ON app.link_logs_default USING btree (app_id, link_id, created_at);


--
-- Name: link_open_attempts_link_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX link_open_attempts_link_idx ON app.link_open_attempts USING btree (app_id, link_id);


--
-- Name: link_open_attempts_opened_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX link_open_attempts_opened_idx ON app.link_open_attempts USING btree (opened_at);


--
-- Name: link_open_attempts_user_opened_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX link_open_attempts_user_opened_idx ON app.link_open_attempts USING btree (app_id, user_id, opened_at);


--
-- Name: order_rights_order_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX order_rights_order_idx ON app.order_rights USING btree (app_id, order_id);


--
-- Name: orders_link_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX orders_link_idx ON ONLY app.orders USING btree (app_id, link_id);


--
-- Name: orders_default_app_id_link_id_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX orders_default_app_id_link_id_idx ON app.orders_default USING btree (app_id, link_id);


--
-- Name: orders_user_paid_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX orders_user_paid_idx ON ONLY app.orders USING btree (app_id, user_id, paid_at DESC, order_id DESC);


--
-- Name: orders_default_app_id_user_id_paid_at_order_id_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX orders_default_app_id_user_id_paid_at_order_id_idx ON app.orders_default USING btree (app_id, user_id, paid_at DESC, order_id DESC);


--
-- Name: payout_account_changes_user_changed_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX payout_account_changes_user_changed_idx ON app.payout_account_changes USING btree (app_id, user_id, changed_at);


--
-- Name: payout_account_verify_attempts_fingerprint_reserved_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX payout_account_verify_attempts_fingerprint_reserved_idx ON app.payout_account_verify_attempts USING btree (app_id, user_id, request_fingerprint, reserved_at);


--
-- Name: payout_account_verify_attempts_idempotency_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX payout_account_verify_attempts_idempotency_key ON app.payout_account_verify_attempts USING btree (app_id, user_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: payout_account_verify_attempts_inflight_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX payout_account_verify_attempts_inflight_key ON app.payout_account_verify_attempts USING btree (app_id, user_id, request_fingerprint) WHERE (status = ANY (ARRAY['reserved'::text, 'unknown'::text]));


--
-- Name: payout_account_verify_attempts_user_date_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX payout_account_verify_attempts_user_date_idx ON app.payout_account_verify_attempts USING btree (app_id, user_id, verify_date);


--
-- Name: payout_accounts_current_alipay_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX payout_accounts_current_alipay_key ON app.payout_accounts USING btree (app_id, alipay_hmac) WHERE is_current;


--
-- Name: payout_accounts_current_bank_card_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX payout_accounts_current_bank_card_key ON app.payout_accounts USING btree (app_id, bank_card_hmac) WHERE is_current;


--
-- Name: payout_accounts_current_user_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX payout_accounts_current_user_key ON app.payout_accounts USING btree (app_id, user_id) WHERE is_current;


--
-- Name: product_refs_platform_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX product_refs_platform_idx ON app.product_refs USING btree (platform);


--
-- Name: push_tokens_live_token_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX push_tokens_live_token_key ON app.push_tokens USING btree (app_id, provider, token) WHERE (revoked_at IS NULL);


--
-- Name: push_tokens_user_bound_sid_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX push_tokens_user_bound_sid_idx ON app.push_tokens USING btree (app_id, user_id, bound_sid);


--
-- Name: refresh_tokens_session_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX refresh_tokens_session_idx ON app.refresh_tokens USING btree (app_id, sid);


--
-- Name: risk_hits_ref_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX risk_hits_ref_idx ON app.risk_hits USING btree (app_id, ref_type, ref_id);


--
-- Name: risk_hits_related_phone_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX risk_hits_related_phone_idx ON app.risk_hits USING btree (app_id, related_phone_hmac) WHERE (related_phone_hmac IS NOT NULL);


--
-- Name: risk_hits_user_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX risk_hits_user_idx ON app.risk_hits USING btree (app_id, user_id) WHERE (user_id IS NOT NULL);


--
-- Name: sessions_device_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX sessions_device_idx ON app.sessions USING btree (app_id, device_id);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX sessions_user_idx ON app.sessions USING btree (app_id, user_id);


--
-- Name: union_accounts_auth_renewed_by_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX union_accounts_auth_renewed_by_idx ON app.union_accounts USING btree (app_id, auth_renewed_by) WHERE (auth_renewed_by IS NOT NULL);


--
-- Name: union_auth_sessions_user_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX union_auth_sessions_user_idx ON app.union_auth_sessions USING btree (app_id, user_id, created_at);


--
-- Name: union_bindings_relation_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX union_bindings_relation_idx ON app.union_bindings USING btree (app_id, platform, relation_id);


--
-- Name: union_bindings_relation_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX union_bindings_relation_key ON app.union_bindings USING btree (app_id, union_account_id, platform, relation_id) WHERE (status = ANY (ARRAY['active'::text, 'invalid'::text, 'blocked'::text]));


--
-- Name: union_bindings_user_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX union_bindings_user_idx ON app.union_bindings USING btree (app_id, user_id);


--
-- Name: union_bindings_user_platform_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX union_bindings_user_platform_key ON app.union_bindings USING btree (app_id, user_id, platform) WHERE (status = ANY (ARRAY['pending_auth'::text, 'active'::text, 'invalid'::text, 'blocked'::text]));


--
-- Name: union_credentials_account_created_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX union_credentials_account_created_idx ON app.union_credentials USING btree (app_id, union_account_id, created_at);


--
-- Name: union_credentials_current_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX union_credentials_current_key ON app.union_credentials USING btree (app_id, union_account_id) WHERE is_current;


--
-- Name: union_pids_account_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX union_pids_account_idx ON app.union_pids USING btree (app_id, platform, union_account_id);


--
-- Name: union_pids_scene_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX union_pids_scene_idx ON app.union_pids USING btree (app_id, platform, pid_scene, status);


--
-- Name: user_risk_state_state_idx; Type: INDEX; Schema: app; Owner: -
--

CREATE INDEX user_risk_state_state_idx ON app.user_risk_state USING btree (app_id, state, frozen_until);


--
-- Name: users_phone_hmac_key; Type: INDEX; Schema: app; Owner: -
--

CREATE UNIQUE INDEX users_phone_hmac_key ON app.users USING btree (app_id, phone_hmac) WHERE (status <> 'deleted'::text);


--
-- Name: job_common_i1; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i1 ON pgboss.job_common USING btree (name, COALESCE(singleton_key, ''::text)) WHERE ((state = 'created'::pgboss.job_state) AND (policy = 'short'::text));


--
-- Name: job_common_i10; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX job_common_i10 ON pgboss.job_common USING btree (name, singleton_key, state DESC, created_on, id) INCLUDE (start_after) WHERE ((state < 'active'::pgboss.job_state) AND (NOT blocked) AND (policy = 'key_strict_fifo'::text));


--
-- Name: job_common_i11; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX job_common_i11 ON pgboss.job_common USING btree (name, priority DESC, created_on, start_after) WHERE ((state < 'active'::pgboss.job_state) AND (NOT blocked));


--
-- Name: job_common_i2; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i2 ON pgboss.job_common USING btree (name, COALESCE(singleton_key, ''::text)) WHERE ((state = 'active'::pgboss.job_state) AND (policy = 'singleton'::text));


--
-- Name: job_common_i3; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i3 ON pgboss.job_common USING btree (name, state, COALESCE(singleton_key, ''::text)) WHERE ((state <= 'active'::pgboss.job_state) AND (policy = 'stately'::text));


--
-- Name: job_common_i4; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i4 ON pgboss.job_common USING btree (name, singleton_on, COALESCE(singleton_key, ''::text)) WHERE ((state <> 'cancelled'::pgboss.job_state) AND (singleton_on IS NOT NULL));


--
-- Name: job_common_i6; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i6 ON pgboss.job_common USING btree (name, COALESCE(singleton_key, ''::text)) WHERE ((state <= 'active'::pgboss.job_state) AND (policy = 'exclusive'::text));


--
-- Name: job_common_i7; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX job_common_i7 ON pgboss.job_common USING btree (name, group_id) WHERE ((state = 'active'::pgboss.job_state) AND (group_id IS NOT NULL));


--
-- Name: job_common_i8; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE UNIQUE INDEX job_common_i8 ON pgboss.job_common USING btree (name, singleton_key) WHERE ((state = ANY (ARRAY['active'::pgboss.job_state, 'retry'::pgboss.job_state, 'failed'::pgboss.job_state])) AND (policy = 'key_strict_fifo'::text));


--
-- Name: job_common_i9; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX job_common_i9 ON pgboss.job_common USING btree (name, id) WHERE (blocking AND (state = 'completed'::pgboss.job_state));


--
-- Name: job_dep_parent_idx; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX job_dep_parent_idx ON pgboss.job_dependency USING btree (parent_name, parent_id);


--
-- Name: queue_stats_i1; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX queue_stats_i1 ON ONLY pgboss.queue_stats USING btree (name, captured_on DESC) INCLUDE (deferred_count, queued_count, ready_count, active_count, failed_count, total_count);


--
-- Name: warning_i1; Type: INDEX; Schema: pgboss; Owner: -
--

CREATE INDEX warning_i1 ON pgboss.warning USING btree (created_on DESC);


--
-- Name: event_log_default_created_at_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.event_log_created_at_idx ATTACH PARTITION app.event_log_default_created_at_idx;


--
-- Name: event_log_default_event_id_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.event_log_event_id_idx ATTACH PARTITION app.event_log_default_event_id_idx;


--
-- Name: event_log_default_pkey; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.event_log_pkey ATTACH PARTITION app.event_log_default_pkey;


--
-- Name: link_logs_default_app_id_link_id_created_at_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.link_logs_link_created_idx ATTACH PARTITION app.link_logs_default_app_id_link_id_created_at_idx;


--
-- Name: link_logs_default_pkey; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.link_logs_pkey ATTACH PARTITION app.link_logs_default_pkey;


--
-- Name: orders_default_app_id_link_id_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.orders_link_idx ATTACH PARTITION app.orders_default_app_id_link_id_idx;


--
-- Name: orders_default_app_id_user_id_paid_at_order_id_idx; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.orders_user_paid_idx ATTACH PARTITION app.orders_default_app_id_user_id_paid_at_order_id_idx;


--
-- Name: orders_default_pkey; Type: INDEX ATTACH; Schema: app; Owner: -
--

ALTER INDEX app.orders_pkey ATTACH PARTITION app.orders_default_pkey;


--
-- Name: job_common_pkey; Type: INDEX ATTACH; Schema: pgboss; Owner: -
--

ALTER INDEX pgboss.job_pkey ATTACH PARTITION pgboss.job_common_pkey;


--
-- Name: agent_runs agent_runs_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER agent_runs_no_rewrite BEFORE UPDATE ON app.agent_runs FOR EACH ROW EXECUTE FUNCTION app.reject_agent_run_rewrite();


--
-- Name: agent_sessions agent_sessions_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER agent_sessions_no_rewrite BEFORE UPDATE ON app.agent_sessions FOR EACH ROW EXECUTE FUNCTION app.reject_agent_session_rewrite();


--
-- Name: audit_logs audit_logs_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER audit_logs_append_only BEFORE DELETE OR UPDATE ON app.audit_logs FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: device_registrations device_registrations_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER device_registrations_no_rewrite BEFORE UPDATE ON app.device_registrations FOR EACH ROW EXECUTE FUNCTION app.reject_device_registration_rewrite();


--
-- Name: event_log event_log_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER event_log_append_only BEFORE DELETE OR UPDATE ON app.event_log FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: link_logs link_logs_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER link_logs_append_only BEFORE DELETE OR UPDATE ON app.link_logs FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: link_open_attempts link_open_attempts_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER link_open_attempts_no_rewrite BEFORE UPDATE ON app.link_open_attempts FOR EACH ROW EXECUTE FUNCTION app.reject_link_open_attempt_rewrite();


--
-- Name: links links_no_promo_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER links_no_promo_rewrite BEFORE UPDATE ON app.links FOR EACH ROW EXECUTE FUNCTION app.reject_link_promo_rewrite();


--
-- Name: links links_no_quote_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER links_no_quote_rewrite BEFORE UPDATE ON app.links FOR EACH ROW EXECUTE FUNCTION app.reject_link_quote_rewrite();


--
-- Name: order_keys order_keys_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER order_keys_append_only BEFORE DELETE OR UPDATE ON app.order_keys FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: order_settlements order_settlements_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER order_settlements_append_only BEFORE DELETE OR UPDATE ON app.order_settlements FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: orders orders_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER orders_no_rewrite BEFORE UPDATE ON app.orders FOR EACH ROW EXECUTE FUNCTION app.reject_order_rewrite();


--
-- Name: payout_account_changes payout_account_changes_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER payout_account_changes_append_only BEFORE DELETE OR UPDATE ON app.payout_account_changes FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: product_key_aliases product_key_aliases_append_only; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER product_key_aliases_append_only BEFORE DELETE OR UPDATE ON app.product_key_aliases FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: product_refs product_refs_no_key_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER product_refs_no_key_rewrite BEFORE UPDATE ON app.product_refs FOR EACH ROW EXECUTE FUNCTION app.reject_product_ref_key_rewrite();


--
-- Name: union_auth_sessions union_auth_sessions_no_rewrite; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER union_auth_sessions_no_rewrite BEFORE UPDATE ON app.union_auth_sessions FOR EACH ROW EXECUTE FUNCTION app.reject_union_auth_session_rewrite();


--
-- Name: union_pids union_pids_no_delete; Type: TRIGGER; Schema: app; Owner: -
--

CREATE TRIGGER union_pids_no_delete BEFORE DELETE ON app.union_pids FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();


--
-- Name: admin_permissions admin_permissions_admin_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_permissions
    ADD CONSTRAINT admin_permissions_admin_fkey FOREIGN KEY (app_id, admin_id) REFERENCES app.admin_users(app_id, id);


--
-- Name: admin_permissions admin_permissions_granted_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.admin_permissions
    ADD CONSTRAINT admin_permissions_granted_by_fkey FOREIGN KEY (app_id, granted_by) REFERENCES app.admin_users(app_id, id);


--
-- Name: agent_cards agent_cards_link_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_cards
    ADD CONSTRAINT agent_cards_link_fkey FOREIGN KEY (app_id, link_id) REFERENCES app.links(app_id, link_id);


--
-- Name: agent_cards agent_cards_run_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_cards
    ADD CONSTRAINT agent_cards_run_fkey FOREIGN KEY (app_id, session_id, run_id) REFERENCES app.agent_runs(app_id, session_id, id);


--
-- Name: agent_messages agent_messages_report_handler_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_messages
    ADD CONSTRAINT agent_messages_report_handler_fkey FOREIGN KEY (app_id, report_handler_id) REFERENCES app.admin_users(app_id, id);


--
-- Name: agent_messages agent_messages_run_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_messages
    ADD CONSTRAINT agent_messages_run_fkey FOREIGN KEY (app_id, session_id, run_id) REFERENCES app.agent_runs(app_id, session_id, id);


--
-- Name: agent_messages agent_messages_session_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_messages
    ADD CONSTRAINT agent_messages_session_fkey FOREIGN KEY (app_id, session_id) REFERENCES app.agent_sessions(app_id, id);


--
-- Name: agent_result_sets agent_result_sets_run_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_result_sets
    ADD CONSTRAINT agent_result_sets_run_fkey FOREIGN KEY (app_id, run_id) REFERENCES app.agent_runs(app_id, id);


--
-- Name: agent_runs agent_runs_session_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_runs
    ADD CONSTRAINT agent_runs_session_fkey FOREIGN KEY (app_id, session_id) REFERENCES app.agent_sessions(app_id, id);


--
-- Name: agent_sessions agent_sessions_device_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_sessions
    ADD CONSTRAINT agent_sessions_device_fkey FOREIGN KEY (app_id, device_id) REFERENCES app.devices(app_id, id);


--
-- Name: agent_sessions agent_sessions_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_sessions
    ADD CONSTRAINT agent_sessions_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: agent_tool_calls agent_tool_calls_run_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.agent_tool_calls
    ADD CONSTRAINT agent_tool_calls_run_fkey FOREIGN KEY (app_id, run_id) REFERENCES app.agent_runs(app_id, id);


--
-- Name: appeals appeals_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.appeals
    ADD CONSTRAINT appeals_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: audit_logs audit_logs_admin_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.audit_logs
    ADD CONSTRAINT audit_logs_admin_fkey FOREIGN KEY (app_id, admin_id) REFERENCES app.admin_users(app_id, id);


--
-- Name: category_blocklist category_blocklist_platform_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.category_blocklist
    ADD CONSTRAINT category_blocklist_platform_fkey FOREIGN KEY (platform) REFERENCES app.platforms(code);


--
-- Name: consent_records consent_records_device_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.consent_records
    ADD CONSTRAINT consent_records_device_fkey FOREIGN KEY (app_id, device_id) REFERENCES app.devices(app_id, id);


--
-- Name: consent_records consent_records_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.consent_records
    ADD CONSTRAINT consent_records_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: device_registrations device_registrations_merged_into_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.device_registrations
    ADD CONSTRAINT device_registrations_merged_into_fkey FOREIGN KEY (app_id, merged_into_user_id) REFERENCES app.users(app_id, id);


--
-- Name: device_registrations device_registrations_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.device_registrations
    ADD CONSTRAINT device_registrations_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: devices devices_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.devices
    ADD CONSTRAINT devices_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: inbox_messages inbox_messages_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.inbox_messages
    ADD CONSTRAINT inbox_messages_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: link_logs link_logs_opener_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE app.link_logs
    ADD CONSTRAINT link_logs_opener_user_fkey FOREIGN KEY (app_id, opener_user_id) REFERENCES app.users(app_id, id);


--
-- Name: link_logs link_logs_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE app.link_logs
    ADD CONSTRAINT link_logs_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: link_open_attempts link_open_attempts_link_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_open_attempts
    ADD CONSTRAINT link_open_attempts_link_fkey FOREIGN KEY (app_id, link_id) REFERENCES app.links(app_id, link_id);


--
-- Name: link_open_attempts link_open_attempts_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.link_open_attempts
    ADD CONSTRAINT link_open_attempts_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: links links_device_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.links
    ADD CONSTRAINT links_device_fkey FOREIGN KEY (app_id, device_id) REFERENCES app.devices(app_id, id);


--
-- Name: links links_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.links
    ADD CONSTRAINT links_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: login_logs login_logs_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.login_logs
    ADD CONSTRAINT login_logs_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: order_rights order_rights_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_rights
    ADD CONSTRAINT order_rights_order_fkey FOREIGN KEY (app_id, order_id) REFERENCES app.order_keys(app_id, order_id);


--
-- Name: order_settlements order_settlements_order_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.order_settlements
    ADD CONSTRAINT order_settlements_order_fkey FOREIGN KEY (app_id, order_id) REFERENCES app.order_keys(app_id, order_id);


--
-- Name: orders orders_identity_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE app.orders
    ADD CONSTRAINT orders_identity_fkey FOREIGN KEY (order_id, attr_at, app_id, platform, sub_order_id) REFERENCES app.order_keys(order_id, attr_at, app_id, platform, sub_order_id);


--
-- Name: orders orders_link_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE app.orders
    ADD CONSTRAINT orders_link_fkey FOREIGN KEY (app_id, link_id) REFERENCES app.links(app_id, link_id);


--
-- Name: orders orders_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE app.orders
    ADD CONSTRAINT orders_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: payout_account_changes payout_account_changes_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_account_changes
    ADD CONSTRAINT payout_account_changes_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: payout_account_verify_attempts payout_account_verify_attempts_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_account_verify_attempts
    ADD CONSTRAINT payout_account_verify_attempts_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: payout_accounts payout_accounts_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.payout_accounts
    ADD CONSTRAINT payout_accounts_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: product_refs product_refs_platform_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.product_refs
    ADD CONSTRAINT product_refs_platform_fkey FOREIGN KEY (platform) REFERENCES app.platforms(code);


--
-- Name: push_tokens push_tokens_device_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.push_tokens
    ADD CONSTRAINT push_tokens_device_fkey FOREIGN KEY (app_id, device_id) REFERENCES app.devices(app_id, id);


--
-- Name: push_tokens push_tokens_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.push_tokens
    ADD CONSTRAINT push_tokens_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: refresh_tokens refresh_tokens_parent_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.refresh_tokens
    ADD CONSTRAINT refresh_tokens_parent_fkey FOREIGN KEY (app_id, parent_hash) REFERENCES app.refresh_tokens(app_id, token_hash);


--
-- Name: refresh_tokens refresh_tokens_session_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.refresh_tokens
    ADD CONSTRAINT refresh_tokens_session_fkey FOREIGN KEY (app_id, sid) REFERENCES app.sessions(app_id, sid);


--
-- Name: risk_hits risk_hits_rule_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.risk_hits
    ADD CONSTRAINT risk_hits_rule_fkey FOREIGN KEY (app_id, rule_id) REFERENCES app.risk_rules(app_id, rule_id);


--
-- Name: risk_hits risk_hits_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.risk_hits
    ADD CONSTRAINT risk_hits_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: sessions sessions_device_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.sessions
    ADD CONSTRAINT sessions_device_fkey FOREIGN KEY (app_id, device_id) REFERENCES app.devices(app_id, id);


--
-- Name: sessions sessions_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.sessions
    ADD CONSTRAINT sessions_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: union_accounts union_accounts_auth_renewed_by_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_accounts
    ADD CONSTRAINT union_accounts_auth_renewed_by_fkey FOREIGN KEY (app_id, auth_renewed_by) REFERENCES app.admin_users(app_id, id);


--
-- Name: union_auth_sessions union_auth_sessions_device_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_auth_sessions
    ADD CONSTRAINT union_auth_sessions_device_fkey FOREIGN KEY (app_id, device_id) REFERENCES app.devices(app_id, id);


--
-- Name: union_auth_sessions union_auth_sessions_link_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_auth_sessions
    ADD CONSTRAINT union_auth_sessions_link_fkey FOREIGN KEY (app_id, link_id) REFERENCES app.links(app_id, link_id);


--
-- Name: union_auth_sessions union_auth_sessions_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_auth_sessions
    ADD CONSTRAINT union_auth_sessions_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: union_bindings union_bindings_account_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_bindings
    ADD CONSTRAINT union_bindings_account_fkey FOREIGN KEY (app_id, platform, union_account_id) REFERENCES app.union_accounts(app_id, platform, id);


--
-- Name: union_bindings union_bindings_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_bindings
    ADD CONSTRAINT union_bindings_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: union_credentials union_credentials_account_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_credentials
    ADD CONSTRAINT union_credentials_account_fkey FOREIGN KEY (app_id, union_account_id) REFERENCES app.union_accounts(app_id, id);


--
-- Name: union_pids union_pids_account_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.union_pids
    ADD CONSTRAINT union_pids_account_fkey FOREIGN KEY (app_id, platform, union_account_id) REFERENCES app.union_accounts(app_id, platform, id);


--
-- Name: user_oauth user_oauth_merged_from_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_oauth
    ADD CONSTRAINT user_oauth_merged_from_fkey FOREIGN KEY (app_id, merged_from_user_id) REFERENCES app.users(app_id, id);


--
-- Name: user_oauth user_oauth_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_oauth
    ADD CONSTRAINT user_oauth_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: user_risk_state user_risk_state_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_risk_state
    ADD CONSTRAINT user_risk_state_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: user_tip_reads user_tip_reads_user_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.user_tip_reads
    ADD CONSTRAINT user_tip_reads_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users(app_id, id);


--
-- Name: users users_parent_fkey; Type: FK CONSTRAINT; Schema: app; Owner: -
--

ALTER TABLE ONLY app.users
    ADD CONSTRAINT users_parent_fkey FOREIGN KEY (app_id, parent_id) REFERENCES app.users(app_id, id);


--
-- Name: job_common dlq_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job_common
    ADD CONSTRAINT dlq_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue(name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;


--
-- Name: job_common q_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.job_common
    ADD CONSTRAINT q_fkey FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;


--
-- Name: queue queue_dead_letter_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.queue
    ADD CONSTRAINT queue_dead_letter_fkey FOREIGN KEY (dead_letter) REFERENCES pgboss.queue(name);


--
-- Name: schedule schedule_name_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.schedule
    ADD CONSTRAINT schedule_name_fkey FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE CASCADE;


--
-- Name: subscription subscription_name_fkey; Type: FK CONSTRAINT; Schema: pgboss; Owner: -
--

ALTER TABLE ONLY pgboss.subscription
    ADD CONSTRAINT subscription_name_fkey FOREIGN KEY (name) REFERENCES pgboss.queue(name) ON DELETE CASCADE;


--
-- Name: SCHEMA app; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA app TO couli_app;
GRANT USAGE ON SCHEMA app TO couli_payout;
GRANT USAGE ON SCHEMA app TO couli_readonly;
GRANT USAGE ON SCHEMA app TO couli_maint;


--
-- Name: SCHEMA pgboss; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA pgboss TO couli_app;
GRANT USAGE ON SCHEMA pgboss TO couli_payout;


--
-- Name: FUNCTION delete_expired_link_open_attempts(p_now timestamp with time zone, p_batch_size integer); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.delete_expired_link_open_attempts(p_now timestamp with time zone, p_batch_size integer) FROM PUBLIC;
GRANT ALL ON FUNCTION app.delete_expired_link_open_attempts(p_now timestamp with time zone, p_batch_size integer) TO couli_maint;


--
-- Name: FUNCTION drop_expired_day_partitions(p_table text, p_now timestamp with time zone); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.drop_expired_day_partitions(p_table text, p_now timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION app.drop_expired_day_partitions(p_table text, p_now timestamp with time zone) TO couli_maint;


--
-- Name: FUNCTION drop_expired_month_partitions(p_table text, p_now timestamp with time zone); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.drop_expired_month_partitions(p_table text, p_now timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION app.drop_expired_month_partitions(p_table text, p_now timestamp with time zone) TO couli_maint;


--
-- Name: FUNCTION ensure_day_partition(p_table text, p_day date); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.ensure_day_partition(p_table text, p_day date) FROM PUBLIC;
GRANT ALL ON FUNCTION app.ensure_day_partition(p_table text, p_day date) TO couli_maint;


--
-- Name: FUNCTION ensure_month_partition(p_table text, p_month date); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.ensure_month_partition(p_table text, p_month date) FROM PUBLIC;
GRANT ALL ON FUNCTION app.ensure_month_partition(p_table text, p_month date) TO couli_maint;


--
-- Name: FUNCTION partition_default_rows(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.partition_default_rows() FROM PUBLIC;
GRANT ALL ON FUNCTION app.partition_default_rows() TO couli_maint;


--
-- Name: FUNCTION reject_agent_run_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_agent_run_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_agent_session_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_agent_session_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_device_registration_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_device_registration_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_link_open_attempt_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_link_open_attempt_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_link_promo_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_link_promo_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_link_quote_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_link_quote_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_order_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_order_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_product_ref_key_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_product_ref_key_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_union_auth_session_rewrite(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_union_auth_session_rewrite() FROM PUBLIC;


--
-- Name: FUNCTION reject_update_delete(); Type: ACL; Schema: app; Owner: -
--

REVOKE ALL ON FUNCTION app.reject_update_delete() FROM PUBLIC;


--
-- Name: TABLE admin_permissions; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE app.admin_permissions TO couli_app;
GRANT SELECT ON TABLE app.admin_permissions TO couli_readonly;


--
-- Name: TABLE admin_users; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.admin_users TO couli_app;


--
-- Name: COLUMN admin_users.id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.login_name; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(login_name) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.password_hash; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(password_hash) ON TABLE app.admin_users TO couli_app;


--
-- Name: COLUMN admin_users.totp_secret_cipher; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(totp_secret_cipher) ON TABLE app.admin_users TO couli_app;


--
-- Name: COLUMN admin_users.totp_bound_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(totp_bound_at) ON TABLE app.admin_users TO couli_app;
GRANT SELECT(totp_bound_at) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.totp_last_step; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(totp_last_step) ON TABLE app.admin_users TO couli_app;
GRANT SELECT(totp_last_step) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.is_super; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(is_super) ON TABLE app.admin_users TO couli_app;
GRANT SELECT(is_super) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.admin_users TO couli_app;
GRANT SELECT(status) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.verify_phone_cipher; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(verify_phone_cipher) ON TABLE app.admin_users TO couli_app;


--
-- Name: COLUMN admin_users.verify_phone_hmac; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(verify_phone_hmac) ON TABLE app.admin_users TO couli_app;


--
-- Name: COLUMN admin_users.verify_phone_set_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(verify_phone_set_at) ON TABLE app.admin_users TO couli_app;
GRANT SELECT(verify_phone_set_at) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.admin_users TO couli_app;
GRANT SELECT(row_version) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: COLUMN admin_users.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.admin_users TO couli_app;
GRANT SELECT(updated_at) ON TABLE app.admin_users TO couli_readonly;


--
-- Name: TABLE agent_cards; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.agent_cards TO couli_app;
GRANT SELECT ON TABLE app.agent_cards TO couli_readonly;


--
-- Name: TABLE agent_messages; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.agent_messages TO couli_app;


--
-- Name: COLUMN agent_messages.id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.session_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(session_id) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.run_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(run_id) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.client_msg_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(client_msg_id) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.role; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(role) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.text; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(text) ON TABLE app.agent_messages TO couli_app;


--
-- Name: COLUMN agent_messages.card_ids; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(card_ids) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(card_ids) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.feedback; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(feedback) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(feedback) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.feedback_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(feedback_at) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(feedback_at) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.reported; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reported) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(reported) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.report_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(report_reason) ON TABLE app.agent_messages TO couli_app;


--
-- Name: COLUMN agent_messages.reported_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reported_at) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(reported_at) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.report_status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(report_status) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(report_status) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.report_handler_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(report_handler_id) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(report_handler_id) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.report_handled_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(report_handled_at) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(report_handled_at) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.report_note; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(report_note) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(report_note) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.badcase; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(badcase) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(badcase) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(row_version) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: COLUMN agent_messages.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.agent_messages TO couli_app;
GRANT SELECT(updated_at) ON TABLE app.agent_messages TO couli_readonly;


--
-- Name: TABLE agent_result_sets; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.agent_result_sets TO couli_app;


--
-- Name: COLUMN agent_result_sets.id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id) ON TABLE app.agent_result_sets TO couli_readonly;


--
-- Name: COLUMN agent_result_sets.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.agent_result_sets TO couli_readonly;


--
-- Name: COLUMN agent_result_sets.run_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(run_id) ON TABLE app.agent_result_sets TO couli_readonly;


--
-- Name: COLUMN agent_result_sets.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.agent_result_sets TO couli_readonly;


--
-- Name: TABLE agent_runs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.agent_runs TO couli_app;


--
-- Name: COLUMN agent_runs.id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.session_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(session_id) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.user_text; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(user_text) ON TABLE app.agent_runs TO couli_app;


--
-- Name: COLUMN agent_runs.intent; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(intent) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(intent) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.model; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(model) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(model) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.model_snapshot; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(model_snapshot) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(model_snapshot) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.prompt_version; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(prompt_version) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.input_tokens; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(input_tokens) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(input_tokens) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.output_tokens; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(output_tokens) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(output_tokens) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.cost_mfen; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(cost_mfen) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(cost_mfen) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.ttft_ms; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(ttft_ms) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(ttft_ms) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.latency_ms; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(latency_ms) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(latency_ms) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.finish_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(finish_reason) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(finish_reason) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.final_event; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(final_event) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(final_event) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.ended_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(ended_at) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(ended_at) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.output_filtered; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(output_filtered) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(output_filtered) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.filter_hits; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(filter_hits) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(filter_hits) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.output_truncated; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(output_truncated) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(output_truncated) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.price_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(price_version) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(price_version) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.result_check_provider; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(result_check_provider) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(result_check_provider) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.judge_model; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(judge_model) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(judge_model) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.page_guide_reject_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(page_guide_reject_reason) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(page_guide_reject_reason) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.accepted_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(accepted_at) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.quota_subjects; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(quota_subjects) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.end_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(end_reason) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(end_reason) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.card_delivered; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(card_delivered) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(card_delivered) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.settle_result; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(settle_result) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(settle_result) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.settled_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(settled_at) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(settled_at) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(row_version) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(updated_at) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.deadline_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(deadline_at) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.end_draft; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(end_draft) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(end_draft) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.cancel_requested_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(cancel_requested_at) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(cancel_requested_at) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.finalize_hold; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(finalize_hold) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(finalize_hold) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: COLUMN agent_runs.finalize_hold_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(finalize_hold_at) ON TABLE app.agent_runs TO couli_app;
GRANT SELECT(finalize_hold_at) ON TABLE app.agent_runs TO couli_readonly;


--
-- Name: TABLE agent_sessions; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.agent_sessions TO couli_app;
GRANT SELECT ON TABLE app.agent_sessions TO couli_readonly;


--
-- Name: COLUMN agent_sessions.last_active_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(last_active_at) ON TABLE app.agent_sessions TO couli_app;


--
-- Name: COLUMN agent_sessions.expired_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(expired_at) ON TABLE app.agent_sessions TO couli_app;


--
-- Name: COLUMN agent_sessions.card_seq; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(card_seq) ON TABLE app.agent_sessions TO couli_app;


--
-- Name: COLUMN agent_sessions.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.agent_sessions TO couli_app;


--
-- Name: COLUMN agent_sessions.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.agent_sessions TO couli_app;


--
-- Name: COLUMN agent_sessions.run_lock_run_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(run_lock_run_id) ON TABLE app.agent_sessions TO couli_app;


--
-- Name: COLUMN agent_sessions.run_lock_expires_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(run_lock_expires_at) ON TABLE app.agent_sessions TO couli_app;


--
-- Name: TABLE agent_tool_calls; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.agent_tool_calls TO couli_app;


--
-- Name: COLUMN agent_tool_calls.id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: COLUMN agent_tool_calls.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: COLUMN agent_tool_calls.run_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(run_id) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: COLUMN agent_tool_calls.seq; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(seq) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: COLUMN agent_tool_calls.name; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(name) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: COLUMN agent_tool_calls.result_digest; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(result_digest) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: COLUMN agent_tool_calls.status; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(status) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: COLUMN agent_tool_calls.latency_ms; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(latency_ms) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: COLUMN agent_tool_calls.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.agent_tool_calls TO couli_readonly;


--
-- Name: TABLE app_versions; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.app_versions TO couli_app;
GRANT SELECT ON TABLE app.app_versions TO couli_readonly;


--
-- Name: TABLE appeals; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.appeals TO couli_app;
GRANT SELECT ON TABLE app.appeals TO couli_readonly;


--
-- Name: COLUMN appeals.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.appeals TO couli_app;


--
-- Name: COLUMN appeals.handler_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(handler_id) ON TABLE app.appeals TO couli_app;


--
-- Name: COLUMN appeals.closed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(closed_at) ON TABLE app.appeals TO couli_app;


--
-- Name: COLUMN appeals.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.appeals TO couli_app;


--
-- Name: COLUMN appeals.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.appeals TO couli_app;


--
-- Name: TABLE articles; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.articles TO couli_app;
GRANT SELECT ON TABLE app.articles TO couli_readonly;


--
-- Name: TABLE audit_logs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.audit_logs TO couli_app;
GRANT SELECT ON TABLE app.audit_logs TO couli_readonly;


--
-- Name: TABLE blocklist; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.blocklist TO couli_app;
GRANT SELECT ON TABLE app.blocklist TO couli_readonly;


--
-- Name: COLUMN blocklist.value_hmac; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(value_hmac) ON TABLE app.blocklist TO couli_app;


--
-- Name: COLUMN blocklist.value; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(value) ON TABLE app.blocklist TO couli_app;


--
-- Name: COLUMN blocklist.violation_type; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(violation_type) ON TABLE app.blocklist TO couli_app;


--
-- Name: COLUMN blocklist.reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reason) ON TABLE app.blocklist TO couli_app;


--
-- Name: COLUMN blocklist.end_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(end_at) ON TABLE app.blocklist TO couli_app;


--
-- Name: COLUMN blocklist.expire_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(expire_at) ON TABLE app.blocklist TO couli_app;


--
-- Name: COLUMN blocklist.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.blocklist TO couli_app;


--
-- Name: COLUMN blocklist.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.blocklist TO couli_app;


--
-- Name: COLUMN blocklist.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.blocklist TO couli_app;


--
-- Name: TABLE category_blocklist; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.category_blocklist TO couli_app;
GRANT SELECT ON TABLE app.category_blocklist TO couli_readonly;


--
-- Name: COLUMN category_blocklist.category_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(category_id) ON TABLE app.category_blocklist TO couli_app;


--
-- Name: COLUMN category_blocklist.keyword; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(keyword) ON TABLE app.category_blocklist TO couli_app;


--
-- Name: COLUMN category_blocklist.reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reason) ON TABLE app.category_blocklist TO couli_app;


--
-- Name: COLUMN category_blocklist.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.category_blocklist TO couli_app;


--
-- Name: COLUMN category_blocklist.updated_by; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_by) ON TABLE app.category_blocklist TO couli_app;


--
-- Name: COLUMN category_blocklist.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.category_blocklist TO couli_app;


--
-- Name: TABLE config_items; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.config_items TO couli_app;
GRANT SELECT ON TABLE app.config_items TO couli_readonly;
GRANT SELECT ON TABLE app.config_items TO couli_payout;


--
-- Name: TABLE consent_records; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.consent_records TO couli_app;
GRANT SELECT ON TABLE app.consent_records TO couli_readonly;


--
-- Name: TABLE device_registrations; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT ON TABLE app.device_registrations TO couli_app;
GRANT SELECT ON TABLE app.device_registrations TO couli_readonly;


--
-- Name: COLUMN device_registrations.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(app_id) ON TABLE app.device_registrations TO couli_app;


--
-- Name: COLUMN device_registrations.device_hash; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(device_hash) ON TABLE app.device_registrations TO couli_app;


--
-- Name: COLUMN device_registrations.user_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(user_id) ON TABLE app.device_registrations TO couli_app;


--
-- Name: COLUMN device_registrations.register_method; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(register_method) ON TABLE app.device_registrations TO couli_app;


--
-- Name: COLUMN device_registrations.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(created_at) ON TABLE app.device_registrations TO couli_app;


--
-- Name: COLUMN device_registrations.merged_into_user_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(merged_into_user_id) ON TABLE app.device_registrations TO couli_app;


--
-- Name: TABLE devices; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.devices TO couli_app;


--
-- Name: COLUMN devices.id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.user_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(user_id) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.device_hash; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(device_hash) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.id_source; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id_source) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.platform; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(platform) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.app_version; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_version) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.last_login_sid; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(last_login_sid) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.revoked_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(revoked_at) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.last_seen_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(last_seen_at) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(row_version) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.devices TO couli_readonly;


--
-- Name: COLUMN devices.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(updated_at) ON TABLE app.devices TO couli_readonly;


--
-- Name: TABLE event_log; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.event_log TO couli_app;
GRANT SELECT,INSERT ON TABLE app.event_log TO couli_payout;
GRANT SELECT ON TABLE app.event_log TO couli_readonly;


--
-- Name: TABLE idempotency_keys; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.idempotency_keys TO couli_app;
GRANT SELECT ON TABLE app.idempotency_keys TO couli_readonly;


--
-- Name: TABLE inbox_messages; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.inbox_messages TO couli_app;
GRANT SELECT ON TABLE app.inbox_messages TO couli_readonly;


--
-- Name: COLUMN inbox_messages.read_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(read_at) ON TABLE app.inbox_messages TO couli_app;


--
-- Name: COLUMN inbox_messages.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.inbox_messages TO couli_app;


--
-- Name: COLUMN inbox_messages.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.inbox_messages TO couli_app;


--
-- Name: TABLE link_logs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.link_logs TO couli_app;
GRANT SELECT ON TABLE app.link_logs TO couli_readonly;


--
-- Name: TABLE link_logs_default; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT ON TABLE app.link_logs_default TO couli_readonly;


--
-- Name: TABLE link_open_attempts; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.link_open_attempts TO couli_app;
GRANT SELECT ON TABLE app.link_open_attempts TO couli_readonly;


--
-- Name: COLUMN link_open_attempts.jump_reported_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(jump_reported_at) ON TABLE app.link_open_attempts TO couli_app;


--
-- Name: COLUMN link_open_attempts.dismissed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(dismissed_at) ON TABLE app.link_open_attempts TO couli_app;


--
-- Name: COLUMN link_open_attempts.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.link_open_attempts TO couli_app;


--
-- Name: COLUMN link_open_attempts.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.link_open_attempts TO couli_app;


--
-- Name: TABLE links; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.links TO couli_app;
GRANT SELECT ON TABLE app.links TO couli_readonly;


--
-- Name: TABLE login_logs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.login_logs TO couli_app;
GRANT SELECT ON TABLE app.login_logs TO couli_readonly;


--
-- Name: TABLE order_keys; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.order_keys TO couli_app;
GRANT SELECT ON TABLE app.order_keys TO couli_readonly;


--
-- Name: TABLE order_rights; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.order_rights TO couli_app;
GRANT SELECT ON TABLE app.order_rights TO couli_readonly;


--
-- Name: TABLE order_settlements; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.order_settlements TO couli_app;
GRANT SELECT ON TABLE app.order_settlements TO couli_readonly;


--
-- Name: TABLE orders; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.orders TO couli_app;
GRANT SELECT ON TABLE app.orders TO couli_readonly;


--
-- Name: TABLE orders_default; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT ON TABLE app.orders_default TO couli_readonly;


--
-- Name: TABLE payout_account_changes; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.payout_account_changes TO couli_app;
GRANT SELECT ON TABLE app.payout_account_changes TO couli_readonly;


--
-- Name: TABLE payout_account_verify_attempts; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.payout_account_verify_attempts TO couli_app;
GRANT SELECT ON TABLE app.payout_account_verify_attempts TO couli_readonly;


--
-- Name: COLUMN payout_account_verify_attempts.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.payout_account_verify_attempts TO couli_app;


--
-- Name: COLUMN payout_account_verify_attempts.unknown_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(unknown_at) ON TABLE app.payout_account_verify_attempts TO couli_app;


--
-- Name: COLUMN payout_account_verify_attempts.resolved_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(resolved_at) ON TABLE app.payout_account_verify_attempts TO couli_app;


--
-- Name: COLUMN payout_account_verify_attempts.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.payout_account_verify_attempts TO couli_app;


--
-- Name: COLUMN payout_account_verify_attempts.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.payout_account_verify_attempts TO couli_app;


--
-- Name: TABLE payout_accounts; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.payout_accounts TO couli_app;
GRANT SELECT ON TABLE app.payout_accounts TO couli_readonly;


--
-- Name: COLUMN payout_accounts.is_current; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(is_current) ON TABLE app.payout_accounts TO couli_app;


--
-- Name: COLUMN payout_accounts.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.payout_accounts TO couli_app;


--
-- Name: COLUMN payout_accounts.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.payout_accounts TO couli_app;


--
-- Name: TABLE platforms; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.platforms TO couli_app;
GRANT SELECT ON TABLE app.platforms TO couli_readonly;


--
-- Name: COLUMN platforms.key_stability; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(key_stability) ON TABLE app.platforms TO couli_app;


--
-- Name: COLUMN platforms.search_support; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(search_support) ON TABLE app.platforms TO couli_app;


--
-- Name: COLUMN platforms.convert_support; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(convert_support) ON TABLE app.platforms TO couli_app;


--
-- Name: COLUMN platforms.order_sync_support; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(order_sync_support) ON TABLE app.platforms TO couli_app;


--
-- Name: COLUMN platforms.stage; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(stage) ON TABLE app.platforms TO couli_app;


--
-- Name: COLUMN platforms.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.platforms TO couli_app;


--
-- Name: TABLE processed_events; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.processed_events TO couli_app;
GRANT SELECT,INSERT ON TABLE app.processed_events TO couli_payout;
GRANT SELECT ON TABLE app.processed_events TO couli_readonly;


--
-- Name: TABLE product_key_aliases; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.product_key_aliases TO couli_app;
GRANT SELECT ON TABLE app.product_key_aliases TO couli_readonly;


--
-- Name: TABLE product_refs; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.product_refs TO couli_app;
GRANT SELECT ON TABLE app.product_refs TO couli_readonly;


--
-- Name: COLUMN product_refs.raw_item_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(raw_item_id) ON TABLE app.product_refs TO couli_app;


--
-- Name: COLUMN product_refs.raw_fetched_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(raw_fetched_at) ON TABLE app.product_refs TO couli_app;


--
-- Name: COLUMN product_refs.canonical_url; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(canonical_url) ON TABLE app.product_refs TO couli_app;


--
-- Name: COLUMN product_refs.title; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(title) ON TABLE app.product_refs TO couli_app;


--
-- Name: COLUMN product_refs.shop_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(shop_id) ON TABLE app.product_refs TO couli_app;


--
-- Name: COLUMN product_refs.shop_type; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(shop_type) ON TABLE app.product_refs TO couli_app;


--
-- Name: COLUMN product_refs.source; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(source) ON TABLE app.product_refs TO couli_app;


--
-- Name: COLUMN product_refs.refreshed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(refreshed_at) ON TABLE app.product_refs TO couli_app;


--
-- Name: COLUMN product_refs.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.product_refs TO couli_app;


--
-- Name: TABLE push_tokens; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE app.push_tokens TO couli_app;
GRANT SELECT ON TABLE app.push_tokens TO couli_readonly;


--
-- Name: COLUMN push_tokens.user_id; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(user_id) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.bound_sid; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(bound_sid) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.token; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(token) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.token_set_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(token_set_at) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.acquired_by_move_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(acquired_by_move_at) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.frozen_until; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(frozen_until) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.revoked_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(revoked_at) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.push_tokens TO couli_app;


--
-- Name: COLUMN push_tokens.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.push_tokens TO couli_app;


--
-- Name: TABLE refresh_tokens; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.refresh_tokens TO couli_app;
GRANT SELECT ON TABLE app.refresh_tokens TO couli_readonly;


--
-- Name: COLUMN refresh_tokens.rotated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(rotated_at) ON TABLE app.refresh_tokens TO couli_app;


--
-- Name: COLUMN refresh_tokens.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.refresh_tokens TO couli_app;


--
-- Name: TABLE risk_hits; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT ON TABLE app.risk_hits TO couli_app;
GRANT SELECT ON TABLE app.risk_hits TO couli_readonly;


--
-- Name: COLUMN risk_hits.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(app_id) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.user_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(user_id) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.rule_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(rule_id) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.risk_action; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(risk_action) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.dimension; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(dimension) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.value_hmac; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(value_hmac) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.ref_type; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(ref_type) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.ref_id; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(ref_id) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.request_type; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(request_type) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.related_phone_hmac; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(related_phone_hmac) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.related_phone_masked; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(related_phone_masked) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.amount_fen; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(amount_fen) ON TABLE app.risk_hits TO couli_app;


--
-- Name: COLUMN risk_hits.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT INSERT(created_at) ON TABLE app.risk_hits TO couli_app;


--
-- Name: TABLE risk_rules; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.risk_rules TO couli_app;
GRANT SELECT ON TABLE app.risk_rules TO couli_readonly;


--
-- Name: COLUMN risk_rules.scene; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(scene) ON TABLE app.risk_rules TO couli_app;


--
-- Name: COLUMN risk_rules.conditions; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(conditions) ON TABLE app.risk_rules TO couli_app;


--
-- Name: COLUMN risk_rules.risk_action; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(risk_action) ON TABLE app.risk_rules TO couli_app;


--
-- Name: COLUMN risk_rules.status; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(status) ON TABLE app.risk_rules TO couli_app;


--
-- Name: COLUMN risk_rules.version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(version) ON TABLE app.risk_rules TO couli_app;


--
-- Name: COLUMN risk_rules.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.risk_rules TO couli_app;


--
-- Name: COLUMN risk_rules.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.risk_rules TO couli_app;


--
-- Name: TABLE sessions; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.sessions TO couli_app;
GRANT SELECT ON TABLE app.sessions TO couli_readonly;


--
-- Name: COLUMN sessions.revoked_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(revoked_at) ON TABLE app.sessions TO couli_app;


--
-- Name: COLUMN sessions.revoke_reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(revoke_reason) ON TABLE app.sessions TO couli_app;


--
-- Name: COLUMN sessions.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.sessions TO couli_app;


--
-- Name: TABLE union_accounts; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.union_accounts TO couli_app;
GRANT SELECT ON TABLE app.union_accounts TO couli_readonly;


--
-- Name: TABLE union_auth_sessions; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.union_auth_sessions TO couli_app;
GRANT SELECT ON TABLE app.union_auth_sessions TO couli_readonly;


--
-- Name: COLUMN union_auth_sessions.used_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(used_at) ON TABLE app.union_auth_sessions TO couli_app;


--
-- Name: TABLE union_bindings; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.union_bindings TO couli_app;
GRANT SELECT ON TABLE app.union_bindings TO couli_readonly;


--
-- Name: TABLE union_credentials; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.union_credentials TO couli_app;


--
-- Name: COLUMN union_credentials.id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(id) ON TABLE app.union_credentials TO couli_readonly;


--
-- Name: COLUMN union_credentials.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.union_credentials TO couli_readonly;


--
-- Name: COLUMN union_credentials.union_account_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(union_account_id) ON TABLE app.union_credentials TO couli_readonly;


--
-- Name: COLUMN union_credentials.expires_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(expires_at) ON TABLE app.union_credentials TO couli_readonly;


--
-- Name: COLUMN union_credentials.is_current; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(is_current) ON TABLE app.union_credentials TO couli_app;
GRANT SELECT(is_current) ON TABLE app.union_credentials TO couli_readonly;


--
-- Name: COLUMN union_credentials.created_at; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(created_at) ON TABLE app.union_credentials TO couli_readonly;


--
-- Name: COLUMN union_credentials.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.union_credentials TO couli_app;
GRANT SELECT(updated_at) ON TABLE app.union_credentials TO couli_readonly;


--
-- Name: TABLE union_pids; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE app.union_pids TO couli_app;
GRANT SELECT ON TABLE app.union_pids TO couli_readonly;


--
-- Name: TABLE user_oauth; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.user_oauth TO couli_app;
GRANT SELECT ON TABLE app.user_oauth TO couli_readonly;


--
-- Name: TABLE user_risk_state; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT ON TABLE app.user_risk_state TO couli_app;
GRANT SELECT ON TABLE app.user_risk_state TO couli_readonly;


--
-- Name: COLUMN user_risk_state.user_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(user_id) ON TABLE app.user_risk_state TO couli_payout;


--
-- Name: COLUMN user_risk_state.app_id; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT(app_id) ON TABLE app.user_risk_state TO couli_payout;


--
-- Name: COLUMN user_risk_state.state; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(state) ON TABLE app.user_risk_state TO couli_app;
GRANT SELECT(state) ON TABLE app.user_risk_state TO couli_payout;


--
-- Name: COLUMN user_risk_state.reason; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reason) ON TABLE app.user_risk_state TO couli_app;


--
-- Name: COLUMN user_risk_state.reason_category; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(reason_category) ON TABLE app.user_risk_state TO couli_app;


--
-- Name: COLUMN user_risk_state.frozen_until; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(frozen_until) ON TABLE app.user_risk_state TO couli_app;


--
-- Name: COLUMN user_risk_state.changed_by; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(changed_by) ON TABLE app.user_risk_state TO couli_app;


--
-- Name: COLUMN user_risk_state.changed_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(changed_at) ON TABLE app.user_risk_state TO couli_app;


--
-- Name: COLUMN user_risk_state.row_version; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(row_version) ON TABLE app.user_risk_state TO couli_app;


--
-- Name: COLUMN user_risk_state.updated_at; Type: ACL; Schema: app; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE app.user_risk_state TO couli_app;


--
-- Name: TABLE user_tip_reads; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE app.user_tip_reads TO couli_app;
GRANT SELECT ON TABLE app.user_tip_reads TO couli_readonly;


--
-- Name: TABLE users; Type: ACL; Schema: app; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE app.users TO couli_app;
GRANT SELECT ON TABLE app.users TO couli_readonly;


--
-- Name: TABLE bam; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.bam TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.bam TO couli_payout;


--
-- Name: TABLE job; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job TO couli_payout;


--
-- Name: TABLE job_common; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job_common TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job_common TO couli_payout;


--
-- Name: TABLE job_dependency; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job_dependency TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.job_dependency TO couli_payout;


--
-- Name: TABLE queue; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.queue TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.queue TO couli_payout;


--
-- Name: TABLE queue_stats; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.queue_stats TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.queue_stats TO couli_payout;


--
-- Name: TABLE schedule; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.schedule TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.schedule TO couli_payout;


--
-- Name: TABLE subscription; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.subscription TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.subscription TO couli_payout;


--
-- Name: TABLE version; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.version TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.version TO couli_payout;


--
-- Name: TABLE warning; Type: ACL; Schema: pgboss; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.warning TO couli_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pgboss.warning TO couli_payout;


--
-- PostgreSQL database dump complete
--

\unrestrict couli
