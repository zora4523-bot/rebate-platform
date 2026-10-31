-- Up Migration
-- B1-15zc (BR-ID-30 正文, ⑦; orchestrator rulings D10-451, D10-454, D10-458). union_raw_payloads is
-- kept 180 days. The table carries the append-only trigger union_raw_payloads_append_only, so rows
-- cannot be deleted one by one: expired month partitions are dropped whole (DROP TABLE is DDL and does
-- not fire the trigger, which stays in place).
--
-- app.drop_expired_month_partitions is deliberately not extended: the frozen tests pin that it refuses
-- this table and that maintenance's DROPPABLE_TABLES is exactly ['event_log']. The new function is
-- separate and takes p_days from the retention.union_raw_payloads_days configuration, but refuses
-- (22023) anything below the BR-ID-30 value of 180 written in it: this is the second gate behind the
-- configuration floor, so a configuration changed by mistake cannot drop too much. 36500 is a technical
-- ceiling against overflow, as in 0102.
--
-- Cutoff: 00:00 (+08:00) of (the +08:00 calendar day of p_now − p_days calendar days). A month partition
-- goes when the upper bound of its ACTUAL range (catalogue, not the name) is at or before the cutoff.
-- fetched_at is the partition key, so every row it can hold is then older than the cutoff: unlike
-- event_log (0022, judged by created_at) no row is read, no index on fetched_at is needed and a
-- concurrent writer cannot add a row that changes the decision. The DEFAULT partition and any other
-- child are never dropped, however old their rows are.
--
-- Written like app.drop_expired_day_partitions (same reasoning), with the month partitions' creation
-- lock. Owner couli_migrator: it owns the parent and, through app.ensure_month_partition (SECURITY
-- DEFINER), every partition, so the DROP needs no new privilege. EXECUTE for couli_maint only; no role
-- gets a direct DELETE or DDL right.
--
-- Compatibility: additive (one function).
-- Recovery: set retention.purge.enabled to false, then apply a corrective migration; partitions dropped
-- by later maintenance calls can only be recovered from a backup.
--
-- Timeouts: only catalogue changes, no table is locked; 5s lock wait and 30s overall as ceilings.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION app.drop_expired_union_raw_payload_partitions(p_now timestamptz, p_days integer)
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
  v_dropped    text[] := ARRAY[]::text[];
BEGIN
  IF p_now IS NULL OR p_days IS NULL THEN
    RAISE EXCEPTION 'drop_expired_union_raw_payload_partitions: p_now and p_days are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  IF NOT isfinite(p_now) THEN
    RAISE EXCEPTION 'drop_expired_union_raw_payload_partitions: p_now must be finite'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The floor is BR-ID-30 ⑦ itself: the second gate behind the configuration.
  IF p_days < 180 OR p_days > 36500 THEN
    RAISE EXCEPTION 'drop_expired_union_raw_payload_partitions: p_days must be between 180 and 36500'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Serialise deletion calls before listing so each drop is reported once.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('app.drop_expired_union_raw_payload_partitions', 0)
  );

  SELECT c.oid INTO v_parent
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = 'union_raw_payloads' AND c.relkind = 'p';
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'drop_expired_union_raw_payload_partitions: app.union_raw_payloads is not a partitioned table'
      USING ERRCODE = 'undefined_table';
  END IF;

  -- Fixed UTC+08:00, never the session TimeZone. Subtract calendar days before converting
  -- local midnight back to an instant (BR-ID-30 正文).
  v_cutoff := (((p_now AT TIME ZONE INTERVAL '8 hours')::date - p_days)::timestamp
    AT TIME ZONE INTERVAL '8 hours');

  FOR v_partition IN
    SELECT c.relname::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = v_parent AND n.nspname = 'app' AND c.relkind = 'r'
      AND c.relname::text ~ '^union_raw_payloads_p[0-9]{4}(0[1-9]|1[0-2])$'
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

  -- Empty runs request no table lock: the hourly runs after 04:00 must not queue ahead of writers.
  IF cardinality(v_candidates) = 0 THEN
    RETURN v_dropped;
  END IF;

  -- Take ALL candidate creation locks before the parent lock. Otherwise an ensure
  -- caller could hold a later candidate lock while waiting for our parent.
  FOREACH v_name IN ARRAY v_candidates LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('app.ensure_month_partition:' || v_name, 0));
  END LOOP;

  -- Parent before children follows writer lock order; ONLY avoids the DEFAULT partition and
  -- the partitions that stay. Every wait, including advisory locks, has a 5s bound.
  -- Do not catch 55P03: the whole statement must roll back, including earlier drops.
  LOCK TABLE ONLY app.union_raw_payloads IN ACCESS EXCLUSIVE MODE;

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

    -- fetched_at is the partition key: an upper bound <= cutoff guarantees that
    -- every row is strictly older than cutoff, without scanning or deleting rows.
    EXECUTE format('DROP TABLE app.%I', v_partition.name);
    v_dropped := array_append(v_dropped, v_partition.name);
  END LOOP;

  RETURN v_dropped;
END
$$;

ALTER FUNCTION app.drop_expired_union_raw_payload_partitions(timestamptz, integer) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.drop_expired_union_raw_payload_partitions(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.drop_expired_union_raw_payload_partitions(timestamptz, integer) TO couli_maint;
