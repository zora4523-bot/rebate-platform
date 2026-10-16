-- Up Migration
-- Price change history (BR-WATCH-05 (2) price_snapshot; BR-WATCH-19 (1) MVP 预埋; 规划/04 §3.2 与
-- 附录 A price_snapshot; ADR-0001 §4.2 #4, #5 按月分区、DEFAULT 分区兜底). Task B1-17a.
-- Compatibility: additive (one new partitioned table with its DEFAULT partition, one partitioned
-- index and grants) plus CREATE OR REPLACE of app.ensure_month_partition that only extends its
-- allow-list. Recovery: restore from backup; no down migration.
--
-- price_snapshot: run-length encoded price history, one row per run of identical
-- (price_fen, coupon_fen, final_price_fen, in_stock) for one (app_id, product_key, source_kind).
-- - The writer (task B1-17b) takes a transaction-level advisory lock on that key, reads the latest
--   row, then either inserts a new run or moves last_observed_at / observation_count of the latest
--   row forward. There is deliberately no unique constraint on the key: every price change is a
--   new row. Failed union queries are never written (BR-WATCH-05).
-- - No user identifiers of any kind (BR-WATCH-19): no user_id, device_id, relation_id,
--   subUnionId, custom_parameters, pid / promotion slot, cPin / xid_buyer, region.
--   goods_sign_plan records which PDD goods_sign plan (search / detail general plan) produced
--   the price; it identifies a plan, not a user.
-- - Partitioned by RANGE (first_observed_at), so the primary key contains it. Only the DEFAULT
--   partition is created here; month partitions are created at runtime by
--   app.ensure_month_partition (pnpm db:partitions). A run keeps its partition while
--   last_observed_at moves forward, because the partition key never changes.
-- - first_observed_at and last_observed_at come from the injected Clock and have no default;
--   created_at defaults to now() only as the technical insert time.
-- - Money checks are shape-only (price_fen > 0, coupon_fen >= 0, final_price_fen > 0). There is
--   no final = price - coupon equation: Taobao's final price may include a member item.
-- - platform is open text like union_raw_payloads.platform; source_kind is the closed set of
--   BR-WATCH-05 (search / detail / quote / convert / watch).
-- - The latest-row index (app_id, product_key, source_kind, first_observed_at DESC) serves the
--   writer's "latest row" read and the price-trend window read.
-- Retention: 13 months (BR-WATCH-05) needs app.drop_expired_month_partitions and
-- platform/maintenance DROPPABLE_TABLES to change together; not in this task. Until then
-- drop_expired_month_partitions keeps rejecting this table.
--
-- Grants: couli_app SELECT and INSERT, and UPDATE only on the two run columns last_observed_at
-- and observation_count (never DELETE or TRUNCATE). No append-only trigger: the run update needs
-- UPDATE, so the column grant is the guard. couli_readonly SELECT. couli_payout gets nothing;
-- couli_maint only reaches the table through the SECURITY DEFINER ensure_month_partition.
-- Partitions get no grants of their own, so direct access to a partition is denied.
--
-- Timeouts: creating an empty table, its index and replacing one function take only short
-- catalog locks; 5s lock wait so a blocked deploy fails fast, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.price_snapshot (
  id                bigint GENERATED ALWAYS AS IDENTITY,
  app_id            text NOT NULL,
  platform          text NOT NULL,
  product_key       text NOT NULL,
  sku_key           text,
  source_kind       text NOT NULL,
  price_fen         bigint NOT NULL,
  coupon_fen        bigint NOT NULL,
  final_price_fen   bigint NOT NULL,
  in_stock          boolean NOT NULL,
  goods_sign_plan   text,
  first_observed_at timestamptz NOT NULL,
  last_observed_at  timestamptz NOT NULL,
  observation_count integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_snapshot_pkey PRIMARY KEY (id, first_observed_at),
  CONSTRAINT price_snapshot_source_kind_check
    CHECK (source_kind IN ('search', 'detail', 'quote', 'convert', 'watch')),
  CONSTRAINT price_snapshot_price_fen_check CHECK (price_fen > 0),
  CONSTRAINT price_snapshot_coupon_fen_check CHECK (coupon_fen >= 0),
  CONSTRAINT price_snapshot_final_price_fen_check CHECK (final_price_fen > 0),
  CONSTRAINT price_snapshot_observation_count_check CHECK (observation_count >= 1),
  CONSTRAINT price_snapshot_observed_order_check CHECK (last_observed_at >= first_observed_at)
) PARTITION BY RANGE (first_observed_at);

CREATE TABLE app.price_snapshot_default PARTITION OF app.price_snapshot DEFAULT;

CREATE INDEX price_snapshot_latest_idx
  ON app.price_snapshot (app_id, product_key, source_kind, first_observed_at DESC);

GRANT SELECT, INSERT ON app.price_snapshot TO couli_app;
GRANT UPDATE (last_observed_at, observation_count) ON app.price_snapshot TO couli_app;
GRANT SELECT ON app.price_snapshot TO couli_readonly;

-- Keep the existing function (0029) unchanged: UTC boundaries, advisory lock, safe search_path
-- and role boundary. Only its allow-list gains price_snapshot (db/AGENTS.md rule 5; mirrored by
-- MONTH_PARTITIONED_TABLES in packages/db/src/partitions.ts).
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
  IF p_table NOT IN ('event_log', 'orders', 'union_raw_payloads', 'price_snapshot') THEN
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
