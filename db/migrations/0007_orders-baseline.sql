-- Up Migration
-- Order baseline (规划/04 §3.2, §2.3; ADR-0001 §4).
-- Compatibility: additive. Recovery: restore from backup; no down migration.
-- Entity UUIDs are UUIDv7 supplied by the application; external identifiers are text.
-- order_keys is immutable and unpartitioned. All order references target it, never orders.
-- The full identity FK binds orders to the key's app, platform, sub-order and attr_at;
-- together with the partitioned PK it permits only one orders row per global key.
-- User/link references include app_id. apps, platform and Agent references await their
-- baseline tables. raw_payload_id is a bigint reference to the future append-only raw
-- payload store; it has no FK to that partitioned table (db/AGENTS.md #7).
-- Unspecified vocabularies (including rights.source and paid_at_source) remain open text.
-- The unnamed 应扣佣金 column is deduction_commission_fen; unknown amounts remain NULL.
-- No amount signs, formulas or booked_base_fen/booked_n_fen pairing are asserted here.
-- TODO(规划/11 §2.3): constrain the four redundant amounts in a later migration — blocked on BR-CALC-27.
-- They are nullable, without defaults or CHECKs (task B1-08a, decision A).
-- CAS: writers compare and increment row_version on orders/order_rights; no trigger writes
-- business state. Prohibitive UPDATE guards only protect identity and write-once fields.
-- Order retention is undecided: no application DELETE grants or partition deletion here.

CREATE TABLE app.order_keys (
  platform     text NOT NULL,
  sub_order_id text NOT NULL,
  order_id     uuid NOT NULL,
  app_id       text NOT NULL,
  attr_at      timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_keys_pkey PRIMARY KEY (platform, sub_order_id),
  CONSTRAINT order_keys_order_id_key UNIQUE (order_id),
  CONSTRAINT order_keys_app_order_key UNIQUE (app_id, order_id),
  CONSTRAINT order_keys_identity_key UNIQUE (order_id, attr_at, app_id, platform, sub_order_id)
);

CREATE TRIGGER order_keys_append_only
  BEFORE UPDATE OR DELETE ON app.order_keys
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

CREATE TABLE app.orders (
  order_id                    uuid NOT NULL,
  app_id                      text NOT NULL,
  platform                    text NOT NULL,
  sub_order_id                text NOT NULL,
  parent_order_id             text,
  shop_type                   text,
  product_key                 text,
  raw_item_id                 text NOT NULL,
  shop_id                     text,
  title                       text,
  image_url                   text,
  quantity                    integer,
  refunded_quantity           integer,
  refunded_quantity_at_credit integer,
  pay_amount_fen              bigint,
  pid                         text,
  relation_id                 text,
  sub_union_id                text,
  custom_params               text,
  link_id                     uuid,
  source_match                text,
  user_id                     uuid,
  buy_type                    text,
  scene_basis                 text,
  user_basis                  text,
  platform_status             text NOT NULL,
  rebate_status               text NOT NULL DEFAULT 'UNATTRIBUTED',
  hold                        boolean NOT NULL DEFAULT false,
  hold_reason                 text,
  rights_pending              boolean NOT NULL DEFAULT false,
  locked                      boolean NOT NULL DEFAULT false,
  row_version                 integer NOT NULL DEFAULT 0,
  commission_version          integer NOT NULL DEFAULT 0,
  reason                      text,
  reason_sub                  text,
  diff_reason_code            text,
  is_presale                  boolean NOT NULL DEFAULT false,
  deposit_paid_at             timestamptz,
  paid_at                     timestamptz,
  paid_at_source              text,
  attr_at                     timestamptz NOT NULL,
  received_at                 timestamptz,
  platform_received_at        timestamptz,
  received_synced_at          timestamptz,
  settled_at                  timestamptz,
  union_settled_at             timestamptz,
  settle_period               text,
  platform_modified_at        timestamptz,
  credit_requires_settle      boolean NOT NULL DEFAULT false,
  credited_at                 timestamptz,
  est_commission_fen          bigint,
  settle_commission_fen       bigint,
  subsidy_commission_fen      bigint,
  booked_base_fen             bigint,
  booked_n_fen                bigint,
  initial_est_fen             bigint,
  n_total_fen                 bigint,
  pre_base_deduct_fen         bigint,
  base_fen                    bigint,
  platform_est_profit_fen     bigint,
  commission_rate_bp          integer,
  is_price_compare            boolean,
  commission_rate_min_bp      integer,
  commission_rate_max_bp      integer,
  activity_type               text,
  source_scene                text,
  agent_session_id            uuid,
  content_hash                text,
  raw_payload_id              bigint,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_pkey PRIMARY KEY (order_id, attr_at),
  CONSTRAINT orders_identity_fkey
    FOREIGN KEY (order_id, attr_at, app_id, platform, sub_order_id)
    REFERENCES app.order_keys (order_id, attr_at, app_id, platform, sub_order_id),
  CONSTRAINT orders_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT orders_link_fkey FOREIGN KEY (app_id, link_id)
    REFERENCES app.links (app_id, link_id),
  CONSTRAINT orders_source_match_check CHECK (source_match IN ('exact', 'product', 'shop', 'none')),
  CONSTRAINT orders_buy_type_check CHECK (buy_type IN ('self', 'share')),
  CONSTRAINT orders_scene_basis_check CHECK (scene_basis IN ('pid', 'param', 'fallback')),
  CONSTRAINT orders_user_basis_check CHECK (user_basis IN ('param', 'claim', 'admin')),
  CONSTRAINT orders_platform_status_check
    CHECK (platform_status IN ('DEPOSIT_PAID', 'PAID', 'RECEIVED', 'SETTLED', 'INVALID')),
  CONSTRAINT orders_rebate_status_check
    CHECK (rebate_status IN ('UNATTRIBUTED', 'ESTIMATED', 'WAITING', 'CREDITED', 'VOID', 'CLAWED_BACK')),
  CONSTRAINT orders_hold_reason_check CHECK (hold_reason IN ('RISK', 'CS', 'UNMAPPED_STATUS')),
  -- Only persisted reasons from contracts/enums/order.yaml; lookup-only and pending codes
  -- NOT_TRACKED, EXPIRED_CLICK, OTHER_TLJ, RELATION_INVALID, CANCELLED are excluded.
  CONSTRAINT orders_reason_check CHECK (reason IN (
    'REFUND', 'RIGHTS', 'PUNISH', 'PRESALE_UNPAID', 'COMMISSION_ZERO', 'OTHER', 'BLACKLIST',
    'PART_REFUND', 'PRICE_COMPARE', 'PRICE_PROTECT', 'SETTLE_DIFF'
  )),
  CONSTRAINT orders_diff_reason_check
    CHECK (diff_reason_code IN ('PART_REFUND', 'PRICE_COMPARE', 'PRICE_PROTECT', 'SETTLE_DIFF')),
  CONSTRAINT orders_settle_period_check CHECK (settle_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
) PARTITION BY RANGE (attr_at);

CREATE TABLE app.orders_default PARTITION OF app.orders DEFAULT;

CREATE INDEX orders_user_paid_idx ON app.orders (app_id, user_id, paid_at DESC, order_id DESC);
CREATE INDEX orders_link_idx ON app.orders (app_id, link_id);

CREATE FUNCTION app.reject_order_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
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

REVOKE ALL ON FUNCTION app.reject_order_rewrite() FROM PUBLIC;

CREATE TRIGGER orders_no_rewrite
  BEFORE UPDATE ON app.orders
  FOR EACH ROW EXECUTE FUNCTION app.reject_order_rewrite();

CREATE TABLE app.order_rights (
  id                       uuid NOT NULL,
  app_id                   text NOT NULL,
  order_id                 uuid NOT NULL,
  source                   text NOT NULL,
  type                     text NOT NULL,
  status                   text NOT NULL,
  amount_fen               bigint,
  deduction_commission_fen bigint,
  occurred_at              timestamptz NOT NULL,
  platform_rights_no       text,
  row_version              integer NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_rights_pkey PRIMARY KEY (id),
  CONSTRAINT order_rights_order_fkey FOREIGN KEY (app_id, order_id)
    REFERENCES app.order_keys (app_id, order_id),
  CONSTRAINT order_rights_type_check
    CHECK (type IN ('RIGHTS', 'PUNISH', 'INVALID_AFTER_SETTLE', 'REFUND_AFTER_SETTLE')),
  CONSTRAINT order_rights_status_check
    CHECK (status IN ('PROCESSING', 'WAIT_COMMISSION', 'SUCCEEDED', 'FAILED'))
);

CREATE INDEX order_rights_order_idx ON app.order_rights (app_id, order_id);

CREATE TABLE app.order_settlements (
  app_id                text NOT NULL,
  order_id              uuid NOT NULL,
  seq                   integer NOT NULL,
  source                text NOT NULL,
  settle_commission_fen bigint NOT NULL,
  settled_at            timestamptz NOT NULL,
  content_hash          text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_settlements_pkey PRIMARY KEY (order_id, seq),
  CONSTRAINT order_settlements_order_fkey FOREIGN KEY (app_id, order_id)
    REFERENCES app.order_keys (app_id, order_id),
  CONSTRAINT order_settlements_source_check CHECK (source IN ('API', 'STATEMENT'))
);

CREATE TRIGGER order_settlements_append_only
  BEFORE UPDATE OR DELETE ON app.order_settlements
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

GRANT SELECT, INSERT ON app.order_keys, app.order_settlements TO couli_app;
GRANT SELECT, INSERT, UPDATE ON app.orders, app.order_rights TO couli_app;
GRANT SELECT ON app.order_keys, app.orders, app.orders_default, app.order_rights,
  app.order_settlements TO couli_readonly;

-- Keep the existing function's UTC boundaries, advisory lock, safe search_path and role
-- boundary. Only extend its allow-list; no date-dependent DDL is executed by this migration.
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

REVOKE ALL ON FUNCTION app.ensure_month_partition(text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ensure_month_partition(text, date) TO couli_maint;
