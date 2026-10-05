-- Up Migration
-- B1-01s, stage 1: day-partition maintenance for link_logs (ADR-0001 §4.2 #4, #5,
-- #8; BR-ID-30 ②). This migration creates functions only, not dated partitions.
-- The caller supplies the day/instant; day boundaries use fixed UTC+08:00.
-- Recovery: disable day-partition maintenance and apply a corrective migration.
-- Data deleted by later maintenance calls can only be recovered from a backup.

CREATE FUNCTION app.ensure_day_partition(p_table text, p_day date)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
SET DateStyle = 'ISO, YMD'
SET TimeZone = 'UTC'
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

ALTER FUNCTION app.ensure_day_partition(text, date) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.ensure_day_partition(text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ensure_day_partition(text, date) TO couli_maint;

CREATE FUNCTION app.drop_expired_day_partitions(p_table text, p_now timestamptz)
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
$$;

ALTER FUNCTION app.drop_expired_day_partitions(text, timestamptz) OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.drop_expired_day_partitions(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.drop_expired_day_partitions(text, timestamptz) TO couli_maint;
