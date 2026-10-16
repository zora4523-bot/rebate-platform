-- Up Migration
-- Commission rule storage (08 BR-CALC-02 / 05 / 06 / 07 / 11 / 17 at SPEC_REF 7c268cb; 规划/04 §3.2
-- rows commission_rule_versions / commission_rules / commission_rule_reserves; ADR-0001 §4).
-- Task B2-01d. The four snapshot tables are B2-01g; publication checks are B2-03f.
-- Compatibility: additive. Three new tables in schema app; no existing object changes. Recovery:
-- restore from backup; no down migration.
--
-- commission_rule_versions: one row per rule version. Version-level fields (status,
-- effective_from, indirect_enabled, base / drafter / publisher / approver columns) live only here,
-- so they are consistent within a version by construction (04 note: moved up from
-- commission_rules). rule_version_id is a UUIDv7 from the application (seeds use a fixed uuid).
-- status ∈ draft / published / revoked (BR-CALC-11); published and revoked rows must carry
-- effective_from (a revoked version was published first). Within one app no two published
-- versions share an effective_from (partial unique index; drafts and revoked versions do not
-- count), which also makes two concurrent publications of the same instant fail on PG. The
-- "strictly greater than every published, unrevoked effective_from" rule, "≥ publication
-- instant", coverage of commission.platforms × L1–L3 × self/share, the BR-CALC-07 cap on the
-- per-level maxima and "indirect_enabled = false ⇒ every r_indirect_bp = 0" are cross-row rules
-- checked by the publication service (B2-03f), not here.
-- commission_rules: one row per (version, platform, level, order_type) (BR-CALC-06); each ratio
-- is smallint basis points with CHECK 0–8000 (BR-CALC-05 / 07 single-item bound); r_indirect_bp
-- defaults to 0.
-- commission_rule_reserves: one reserve_bp per (version, platform), CHECK 0–10000 (BR-CALC-02).
-- platform: a foreign key to the catalog dictionary app.platforms (code), which already holds the
-- contract values of contracts/enums/platform.yaml, chosen over a CHECK so a new platform needs
-- only a dictionary row. Rules and reserves reference their version through
-- (app_id, rule_version_id), so a row cannot hang off another app's version; admin references
-- use (app_id, id) of admin_users for the same reason (MATCH SIMPLE: NULL skips the check).
-- Foreign keys do not cascade (db/AGENTS.md rule 7). No trigger is added (rule 8).
--
-- Grants: couli_app gets SELECT and INSERT on all three tables and column-level UPDATE on
-- commission_rule_versions (status, publisher_id, published_at, revoked_at,
-- indirect_approver_id, indirect_approved_at) only; contents (effective_from, indirect_enabled,
-- ratios, reserves) cannot change after insert and nothing can be deleted. couli_readonly gets
-- SELECT on all three tables. couli_payout and couli_maint get nothing.
--
-- Timeouts: only new, empty tables are created; the only locks on existing tables are the brief
-- SHARE ROW EXCLUSIVE locks on app.admin_users and app.platforms for the new foreign keys. 5s
-- lock wait so a blocked deploy fails fast instead of queueing traffic behind it; 30s overall as
-- a ceiling for catalog changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.commission_rule_versions (
  rule_version_id      uuid NOT NULL,
  app_id               text NOT NULL,
  status               text NOT NULL DEFAULT 'draft',
  effective_from       timestamptz,
  indirect_enabled     boolean NOT NULL DEFAULT false,
  base_version_id      uuid,
  drafter_id           uuid,
  publisher_id         uuid,
  published_at         timestamptz,
  revoked_at           timestamptz,
  indirect_approver_id uuid,
  indirect_approved_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_rule_versions_pkey PRIMARY KEY (rule_version_id),
  CONSTRAINT commission_rule_versions_app_id_rule_version_id_key UNIQUE (app_id, rule_version_id),
  CONSTRAINT commission_rule_versions_status_check
    CHECK (status IN ('draft', 'published', 'revoked')),
  CONSTRAINT commission_rule_versions_effective_from_check
    CHECK (status = 'draft' OR effective_from IS NOT NULL),
  CONSTRAINT commission_rule_versions_base_version_id_fkey FOREIGN KEY (app_id, base_version_id)
    REFERENCES app.commission_rule_versions (app_id, rule_version_id) MATCH SIMPLE,
  CONSTRAINT commission_rule_versions_drafter_id_fkey FOREIGN KEY (app_id, drafter_id)
    REFERENCES app.admin_users (app_id, id) MATCH SIMPLE,
  CONSTRAINT commission_rule_versions_publisher_id_fkey FOREIGN KEY (app_id, publisher_id)
    REFERENCES app.admin_users (app_id, id) MATCH SIMPLE,
  CONSTRAINT commission_rule_versions_indirect_approver_id_fkey
    FOREIGN KEY (app_id, indirect_approver_id)
    REFERENCES app.admin_users (app_id, id) MATCH SIMPLE
);

CREATE UNIQUE INDEX commission_rule_versions_published_effective_from_key
  ON app.commission_rule_versions (app_id, effective_from)
  WHERE status = 'published';

CREATE TABLE app.commission_rules (
  rule_version_id uuid NOT NULL,
  app_id          text NOT NULL,
  platform        text NOT NULL,
  level           text NOT NULL,
  order_type      text NOT NULL,
  r_own_bp        smallint NOT NULL,
  r_direct_bp     smallint NOT NULL,
  r_indirect_bp   smallint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_rules_pkey PRIMARY KEY (rule_version_id, platform, level, order_type),
  CONSTRAINT commission_rules_level_check CHECK (level IN ('L1', 'L2', 'L3')),
  CONSTRAINT commission_rules_order_type_check CHECK (order_type IN ('self', 'share')),
  CONSTRAINT commission_rules_r_own_bp_check CHECK (r_own_bp BETWEEN 0 AND 8000),
  CONSTRAINT commission_rules_r_direct_bp_check CHECK (r_direct_bp BETWEEN 0 AND 8000),
  CONSTRAINT commission_rules_r_indirect_bp_check CHECK (r_indirect_bp BETWEEN 0 AND 8000),
  CONSTRAINT commission_rules_rule_version_id_fkey FOREIGN KEY (app_id, rule_version_id)
    REFERENCES app.commission_rule_versions (app_id, rule_version_id),
  CONSTRAINT commission_rules_platform_fkey FOREIGN KEY (platform)
    REFERENCES app.platforms (code)
);

CREATE TABLE app.commission_rule_reserves (
  rule_version_id uuid NOT NULL,
  app_id          text NOT NULL,
  platform        text NOT NULL,
  reserve_bp      smallint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_rule_reserves_pkey PRIMARY KEY (rule_version_id, platform),
  CONSTRAINT commission_rule_reserves_reserve_bp_check CHECK (reserve_bp BETWEEN 0 AND 10000),
  CONSTRAINT commission_rule_reserves_rule_version_id_fkey FOREIGN KEY (app_id, rule_version_id)
    REFERENCES app.commission_rule_versions (app_id, rule_version_id),
  CONSTRAINT commission_rule_reserves_platform_fkey FOREIGN KEY (platform)
    REFERENCES app.platforms (code)
);

GRANT SELECT, INSERT
  ON app.commission_rule_versions, app.commission_rules, app.commission_rule_reserves
  TO couli_app;
GRANT UPDATE (status, publisher_id, published_at, revoked_at, indirect_approver_id,
  indirect_approved_at)
  ON app.commission_rule_versions TO couli_app;

GRANT SELECT
  ON app.commission_rule_versions, app.commission_rules, app.commission_rule_reserves
  TO couli_readonly;
