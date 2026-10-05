-- Up Migration
-- Catalog baseline (规划/04 §2.1, §3.2 rows platforms / product_refs / product_key_aliases /
-- category_blocklist; BR-PROD-02, BR-PROD-03, BR-PROD-05, BR-PROD-10; SPEC_REF b9f54fe;
-- ADR-0001 §4). Writer of all four tables: catalog.
-- Compatibility: additive. Recovery: restore from backup; no down migration.
-- product_pools / pool_items are not part of this batch.
--
-- platforms is the platform dictionary (04 §2.1): one row per string platform code, no
-- app_id (it is global, like the contracts enum `platform`). Adding a platform adds a row;
-- code never branches on an enum of platforms or prefixes (BR-PROD-02, BR-PROD-10).
-- key_prefix is the bare product_key prefix (without ':'); NULL means the platform has no
-- product form and never gets a product_key (eleme). key_stability uses the four values of
-- contracts/enums/platform.yaml key_stability; every seed row is unverified until the
-- CAP-*-01 stability checks pass (BR-PROD-03). The capability marks keep the distinctions of
-- the 04 §2.1 table as text values, not booleans:
--   supported   ✔ in 04 §2.1
--   unverified  capability not verified (meituan search: CAP-MT-06, 09 U-81, G-52)
--   activity    activity links only (meituan conversion)
--   p1 / p2     planned for that phase
--   none        no such capability (—)
-- stage is the rollout phase: m_beta (M-内测), p1, p2. meituan is p1 by D15.
-- Whether a capability is switched on at runtime is configuration (search.enabled.<platform>,
-- convert.enabled.<platform>), not these columns. couli_app may update the marks and
-- key_stability, but never code or key_prefix: product keys already written depend on them.
--
-- product_refs (BR-PROD-05) maps (app_id, product_key) to the latest union raw_item_id. Only
-- the sources search, detail, parse and pool write it; order sync never does. raw_item_id is
-- stored verbatim as text. refreshed_at is the receive moment of the union response, set by
-- the writer from the injected Clock; writers use a conditional UPDATE (... AND
-- refreshed_at < $new) so an older response never overwrites a newer row. canonical_url is
-- nullable (04). shop_id and shop_type are nullable too: shop_type is a pending sub-item of
-- BR-PROD-10 and stays open text like orders.shop_type (0007). The product_key prefix is not
-- tied to platform by a CHECK; resolveProductKey / deriveProductKey own that (BR-PROD-03).
-- A written product_key is immutable (BR-PROD-02): the UPDATE grant excludes app_id,
-- product_key and platform, and a prohibitive trigger (db/AGENTS.md #8) also rejects key
-- rewrites by the owner.
--
-- product_key format CHECK (BR-PROD-02), used on product_refs.product_key and on both alias
-- keys: `<key_prefix>:<stable_id>`, prefix lowercase [a-z0-9]+, stable_id 1-124 characters
-- from printable ASCII 0x21-0x7E without '#', '/', '?', whole string at most 128 characters.
-- The bracket ranges !-" $-. 0-> @-~ are exactly 0x21-0x7E minus 0x23, 0x2F and 0x3F.
--
-- product_key_aliases records one-to-one derivation rule changes only (BR-PROD-02); a change
-- of granularity (e.g. jd item -> sku) must not be expressed as aliases. Global like the
-- derivation rule itself (no app_id). Insert-only: couli_app gets SELECT and INSERT, and the
-- append-only trigger of 0003 rejects UPDATE and DELETE for every role. old_key and new_key
-- are each unique, so the mapping stays one-to-one; adr_id names the approving ADR.
--
-- category_blocklist (04 §3.2): category / keyword blocklist for search and material feed
-- filtering, per app and platform. category_id is the platform category ID as text; keyword
-- is nullable. status and updated_by stay open text: no contract vocabulary exists yet;
-- updated_by is an opaque actor identifier as in config_items (0010). Rows are disabled via
-- status, not deleted (no DELETE grant). id is a UUIDv7 supplied by the application.
--
-- product_refs.platform and category_blocklist.platform reference platforms.code without
-- cascades. Platform references of earlier tables (orders, links ...) are not added here.
-- app_id has no foreign key yet: the apps baseline is pending (as in 0005, 0010).

CREATE TABLE app.platforms (
  code                text NOT NULL,
  key_prefix          text,
  key_stability       text NOT NULL,
  search_support      text NOT NULL,
  convert_support     text NOT NULL,
  order_sync_support  text NOT NULL,
  stage               text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platforms_pkey PRIMARY KEY (code),
  CONSTRAINT platforms_key_prefix_key UNIQUE (key_prefix),
  CONSTRAINT platforms_code_check CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT platforms_key_prefix_check CHECK (key_prefix ~ '^[a-z0-9]+$'),
  CONSTRAINT platforms_key_stability_check
    CHECK (key_stability IN ('unverified', 'stable_24h', 'stable_7d', 'unstable')),
  CONSTRAINT platforms_search_support_check
    CHECK (search_support IN ('supported', 'unverified', 'activity', 'p1', 'p2', 'none')),
  CONSTRAINT platforms_convert_support_check
    CHECK (convert_support IN ('supported', 'unverified', 'activity', 'p1', 'p2', 'none')),
  CONSTRAINT platforms_order_sync_support_check
    CHECK (order_sync_support IN ('supported', 'unverified', 'activity', 'p1', 'p2', 'none')),
  CONSTRAINT platforms_stage_check CHECK (stage IN ('m_beta', 'p1', 'p2'))
);

-- Seed: the nine platforms of 04 §2.1 with the key_prefix values of BR-PROD-02.
INSERT INTO app.platforms
  (code, key_prefix, key_stability, search_support, convert_support, order_sync_support, stage)
VALUES
  ('taobao',   'tb',  'unverified', 'supported',  'supported', 'supported', 'm_beta'),
  ('jd',       'jd',  'unverified', 'supported',  'supported', 'supported', 'm_beta'),
  ('pdd',      'pdd', 'unverified', 'supported',  'supported', 'supported', 'm_beta'),
  ('meituan',  'mt',  'unverified', 'unverified', 'activity',  'supported', 'p1'),
  ('vip',      'vip', 'unverified', 'p1',         'p1',        'p1',        'p1'),
  ('douyin',   'dy',  'unverified', 'p1',         'p1',        'p1',        'p1'),
  ('eleme',    NULL,  'unverified', 'none',       'p1',        'p1',        'p1'),
  ('kuaishou', 'ks',  'unverified', 'none',       'p2',        'p2',        'p2'),
  ('suning',   'sn',  'unverified', 'none',       'p2',        'p2',        'p2');

CREATE TABLE app.product_refs (
  app_id          text NOT NULL,
  product_key     text NOT NULL,
  platform        text NOT NULL,
  raw_item_id     text NOT NULL,
  raw_fetched_at  timestamptz NOT NULL,
  canonical_url   text,
  title           text NOT NULL,
  shop_id         text,
  shop_type       text,
  source          text NOT NULL,
  refreshed_at    timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_refs_pkey PRIMARY KEY (app_id, product_key),
  CONSTRAINT product_refs_product_key_check
    CHECK (char_length(product_key) <= 128
      AND product_key ~ '^[a-z0-9]+:[!-"$-.0->@-~]{1,124}$'),
  CONSTRAINT product_refs_raw_item_id_check CHECK (raw_item_id <> ''),
  CONSTRAINT product_refs_source_check CHECK (source IN ('search', 'detail', 'parse', 'pool')),
  CONSTRAINT product_refs_platform_fkey FOREIGN KEY (platform)
    REFERENCES app.platforms (code)
);

CREATE INDEX product_refs_platform_idx ON app.product_refs (platform);

CREATE FUNCTION app.reject_product_ref_key_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
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

REVOKE ALL ON FUNCTION app.reject_product_ref_key_rewrite() FROM PUBLIC;

CREATE TRIGGER product_refs_no_key_rewrite
  BEFORE UPDATE ON app.product_refs
  FOR EACH ROW EXECUTE FUNCTION app.reject_product_ref_key_rewrite();

CREATE TABLE app.product_key_aliases (
  old_key     text NOT NULL,
  new_key     text NOT NULL,
  reason      text NOT NULL,
  adr_id      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_key_aliases_pkey PRIMARY KEY (old_key),
  CONSTRAINT product_key_aliases_new_key_key UNIQUE (new_key),
  CONSTRAINT product_key_aliases_distinct_check CHECK (old_key <> new_key),
  CONSTRAINT product_key_aliases_old_key_check
    CHECK (char_length(old_key) <= 128
      AND old_key ~ '^[a-z0-9]+:[!-"$-.0->@-~]{1,124}$'),
  CONSTRAINT product_key_aliases_new_key_check
    CHECK (char_length(new_key) <= 128
      AND new_key ~ '^[a-z0-9]+:[!-"$-.0->@-~]{1,124}$'),
  CONSTRAINT product_key_aliases_reason_check CHECK (reason <> ''),
  CONSTRAINT product_key_aliases_adr_id_check CHECK (adr_id <> '')
);

CREATE TRIGGER product_key_aliases_append_only
  BEFORE UPDATE OR DELETE ON app.product_key_aliases
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

CREATE TABLE app.category_blocklist (
  id           uuid NOT NULL,
  app_id       text NOT NULL,
  platform     text NOT NULL,
  category_id  text NOT NULL,
  keyword      text,
  reason       text NOT NULL,
  status       text NOT NULL,
  updated_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_blocklist_pkey PRIMARY KEY (id),
  CONSTRAINT category_blocklist_entry_key
    UNIQUE NULLS NOT DISTINCT (app_id, platform, category_id, keyword),
  CONSTRAINT category_blocklist_platform_fkey FOREIGN KEY (platform)
    REFERENCES app.platforms (code)
);

GRANT SELECT, INSERT ON app.platforms, app.product_refs, app.product_key_aliases,
  app.category_blocklist TO couli_app;
GRANT UPDATE (key_stability, search_support, convert_support, order_sync_support, stage,
  updated_at) ON app.platforms TO couli_app;
GRANT UPDATE (raw_item_id, raw_fetched_at, canonical_url, title, shop_id, shop_type, source,
  refreshed_at, updated_at) ON app.product_refs TO couli_app;
GRANT UPDATE (category_id, keyword, reason, status, updated_by, updated_at)
  ON app.category_blocklist TO couli_app;
GRANT SELECT ON app.platforms, app.product_refs, app.product_key_aliases,
  app.category_blocklist TO couli_readonly;
