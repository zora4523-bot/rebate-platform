-- Up Migration
-- B1-01j, stage 1: maintenance entry points for couli_maint (ADR-0001 §4.2 #4, #8,
-- #16; BR-ID-30 ⑧, ⑫, ⑯, ⑰). No partitions are created or deleted by this migration.
-- Compatibility: additive; ensure_month_partition and its allow-list are unchanged.
-- Recovery: disable the worker maintenance schedule and apply a corrective migration.
-- Data deleted by later maintenance calls can only be recovered from a backup.

CREATE FUNCTION app.drop_expired_month_partitions(p_table text, p_now timestamptz)
RETURNS text[]
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_parent     oid;
  v_cutoff     timestamptz;
  v_partition  record;
  v_bounds     text[];
  v_candidates text[] := ARRAY[]::text[];
  v_name       text;
  v_has_recent boolean;
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
      v_candidates := array_append(v_candidates, v_partition.name);
    END IF;
  END LOOP;

  IF cardinality(v_candidates) = 0 THEN
    RETURN v_dropped;
  END IF;

  -- Acquire all creation locks before taking any relation locks: otherwise an ensure
  -- caller could hold a later partition's advisory lock while waiting for our parent.
  FOREACH v_name IN ARRAY v_candidates LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('app.ensure_month_partition:' || v_name, 0));
  END LOOP;

  -- DROP also needs the parent's exclusive lock. Take it before child locks to avoid
  -- deadlocking writers that lock the parent first and then route into a child.
  -- ONLY avoids recursively locking unrelated/default partitions.
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
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM app.%I WHERE created_at >= $1)',
      v_partition.name) INTO v_has_recent USING v_cutoff;
    IF NOT v_has_recent THEN
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

CREATE FUNCTION app.partition_default_rows()
RETURNS TABLE (table_name text, default_partition text, row_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
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

ALTER FUNCTION app.partition_default_rows() OWNER TO couli_migrator;
REVOKE ALL ON FUNCTION app.partition_default_rows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.partition_default_rows() TO couli_maint;
