-- Up Migration
-- Product pools and their items (规划/04 §3.2; 08 BR-PROD-08 ③; orchestrator ruling D10-452 ②;
-- contract schemas AdminProductPool, AdminPoolItem). Task B1-05p; the pool logic comes later.
-- Compatibility: additive. Two new empty tables, named constraints, a composite foreign key between
-- them, one read index, grants.
-- Recovery: restore from backup; no down migration.
--
-- product_pools: one row per pool of one App; (app_id, pool_id) is the key, so one pool_id under two
--   Apps is two independent pools. pool_id is a UUIDv7 from the application. status follows the
--   enum product_pool_status. revision is the CAS value of adminUpdateProductPool. created_by is the
--   admin account, a composite foreign key to app.admin_users (app_id, id), as the other uuid
--   created_by columns.
-- pool_items: one row per product of a pool; the primary key (app_id, pool_id, product_key) is the
--   unique key of BR-PROD-08 ③. Adding a product again rewrites sort, start_at and end_at only;
--   created_at and created_by stay. raw_item_id is the union's item id string, kept as is (BR-PROD-05).
--   price_fen, coupon_fen, final_price_fen are the last refreshed quote and quoted_at its time
--   (BR-PRICE-11); how the three relate is the writer's concern, not checked here. status follows
--   the enum pool_item_status. sort is at least 0 like the contract AdminPoolSort. start_at and
--   end_at are each nullable (no bound); with both set end_at is later. invalid_reason is what the
--   operator sees after a failed re-check. Items reference their pool without a cascade (db/AGENTS.md
--   rule 7): a pool with items cannot be deleted.
--   pool_items_read_idx serves the read path inside a pool (order by sort, then product_key).
-- Written only by the catalog module (couli_app). Neither table is append-only: the console deletes
-- items and takes them on and off the shelf, so there is no guard trigger.
-- Retention: none here.
--
-- Grants: couli_app SELECT, INSERT, UPDATE, DELETE; couli_readonly SELECT. couli_payout and
-- couli_maint get nothing.
--
-- Timeouts: only new, empty tables are created; the foreign keys to app.admin_users take a short
-- SHARE ROW EXCLUSIVE lock there and validate nothing (the new tables are empty). 5s lock wait so
-- a blocked deploy fails fast, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.product_pools (
  app_id     text NOT NULL,
  pool_id    uuid NOT NULL,
  name       text NOT NULL,
  status     text NOT NULL,
  revision   bigint NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_pools_pkey PRIMARY KEY (app_id, pool_id),
  CONSTRAINT product_pools_created_by_fkey FOREIGN KEY (app_id, created_by)
    REFERENCES app.admin_users (app_id, id),
  CONSTRAINT product_pools_app_id_check CHECK (app_id <> ''),
  CONSTRAINT product_pools_name_check CHECK (name <> ''),
  CONSTRAINT product_pools_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT product_pools_revision_check CHECK (revision >= 0)
);

CREATE TABLE app.pool_items (
  app_id          text NOT NULL,
  pool_id         uuid NOT NULL,
  product_key     text NOT NULL,
  platform        text NOT NULL,
  raw_item_id     text NOT NULL,
  title           text NOT NULL,
  image           text,
  price_fen       bigint NOT NULL,
  coupon_fen      bigint NOT NULL,
  final_price_fen bigint NOT NULL,
  quoted_at       timestamptz NOT NULL,
  status          text NOT NULL,
  sort            integer NOT NULL DEFAULT 0,
  start_at        timestamptz,
  end_at          timestamptz,
  invalid_reason  text,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pool_items_pkey PRIMARY KEY (app_id, pool_id, product_key),
  CONSTRAINT pool_items_pool_fkey FOREIGN KEY (app_id, pool_id)
    REFERENCES app.product_pools (app_id, pool_id),
  CONSTRAINT pool_items_created_by_fkey FOREIGN KEY (app_id, created_by)
    REFERENCES app.admin_users (app_id, id),
  CONSTRAINT pool_items_product_key_check CHECK (product_key <> ''),
  CONSTRAINT pool_items_platform_check CHECK (platform IN (
    'taobao', 'jd', 'pdd', 'meituan', 'vip', 'douyin', 'eleme', 'kuaishou', 'suning'
  )),
  CONSTRAINT pool_items_raw_item_id_check CHECK (raw_item_id <> ''),
  CONSTRAINT pool_items_price_fen_check CHECK (price_fen >= 0),
  CONSTRAINT pool_items_coupon_fen_check CHECK (coupon_fen >= 0),
  CONSTRAINT pool_items_final_price_fen_check CHECK (final_price_fen >= 0),
  CONSTRAINT pool_items_status_check CHECK (status IN ('online', 'offline')),
  CONSTRAINT pool_items_sort_check CHECK (sort >= 0),
  CONSTRAINT pool_items_validity_check CHECK (end_at > start_at)
);

CREATE INDEX pool_items_read_idx ON app.pool_items (app_id, pool_id, sort, product_key);

GRANT SELECT, INSERT, UPDATE, DELETE ON app.product_pools TO couli_app;
GRANT SELECT ON app.product_pools TO couli_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.pool_items TO couli_app;
GRANT SELECT ON app.pool_items TO couli_readonly;
