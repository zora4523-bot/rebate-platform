-- Up Migration
-- B1-01zk, stage 1 (BR-ID-30 正文, ② and ⑯; ADR-0001 §4.2 #16). Two maintenance changes:
--
-- ① link_open_attempts retention: same period as link_logs (90 days), deleted by row on
--    opened_at (the moment the open succeeded), with the BR-ID-30 cutoff "run day 00:00
--    (+08:00) − 90 days" (strictly older rows go; a row exactly at the cutoff is kept). The
--    table is not partitioned, couli_maint has no DELETE privilege and no direct DELETE is
--    granted to anyone: app.delete_expired_link_open_attempts (SECURITY DEFINER, owner
--    couli_migrator, EXECUTE for couli_maint only) deletes at most p_batch_size (1..10000) rows
--    per call and returns the count. The maintenance worker calls it in the same daily run as
--    the link_logs day-partition drop, repeating until it returns 0. The write-once trigger
--    (link_open_attempts_no_rewrite, UPDATE only) is not touched. Rows locked by a concurrent
--    writer are skipped and picked up by a later batch or run. A new index on opened_at keeps
--    every batch bounded instead of scanning the table.
--
-- ② event_log partition drop: app.drop_expired_month_partitions checked "no row with
--    created_at >= cutoff" with an EXISTS range query, which without an index (and often even
--    with one but without column statistics) is a full partition scan; the post-lock recheck
--    blocked event_log writers for that whole scan. A partitioned index on (created_at) now
--    covers the parent, DEFAULT and every month partition (existing ones here, later ones via
--    app.ensure_month_partition, which attaches children to the parent's indexes). The function
--    is replaced with the same body except that both checks read max(created_at), which the
--    planner answers from the index end (one backward index probe) regardless of statistics.
--    Retention semantics are unchanged: a row with created_at >= cutoff keeps the whole
--    partition; an empty partition reads NULL and is dropped as before.
--
-- Compatibility: additive (one new function, two new indexes); the replaced function keeps its
-- signature, owner and grants (restated below, idempotent).
-- Recovery: disable the maintenance schedule and apply a corrective migration; rows deleted by
-- later maintenance calls can only be recovered from a backup.
--
-- Timeouts: both tables are small before release, so the SHARE locks taken by the two CREATE
-- INDEX statements are short; 5s lock wait so a blocked deploy fails fast instead of queueing
-- writers behind it, 60s overall as a ceiling for the two index builds.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ① -------------------------------------------------------------------------------------------

CREATE INDEX link_open_attempts_opened_idx ON app.link_open_attempts (opened_at);

CREATE FUNCTION app.delete_expired_link_open_attempts(p_now timestamptz, p_batch_size integer)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
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

ALTER FUNCTION app.delete_expired_link_open_attempts(timestamptz, integer) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.delete_expired_link_open_attempts(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.delete_expired_link_open_attempts(timestamptz, integer) TO couli_maint;

-- ② -------------------------------------------------------------------------------------------

CREATE INDEX event_log_created_at_idx ON app.event_log (created_at);

CREATE OR REPLACE FUNCTION app.drop_expired_month_partitions(p_table text, p_now timestamptz)
RETURNS text[]
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
SET DateStyle = 'ISO, YMD'
SET TimeZone = 'UTC'
AS $$
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
$$;

ALTER FUNCTION app.drop_expired_month_partitions(text, timestamptz) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.drop_expired_month_partitions(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.drop_expired_month_partitions(text, timestamptz) TO couli_maint;
