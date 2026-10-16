-- Up Migration
-- Configuration history (规划/04 §3.2 config_items / kill_switches "修改记审计", §10 配置支持回滚与
-- 版本、操作记录; 规划/01 F-CFG-07 可查修改记录、可恢复). Task F1-10a; table shape follows the
-- orchestrator ruling in couli-runs/F1-10a brief §9.2 (rulings 1 and 3).
-- Compatibility: additive. One new ordinary (non-partitioned) table in schema app plus a backfill
-- INSERT from app.config_items; no existing object changes. Recovery: restore from backup; no down
-- migration.
--
-- config_item_versions: one append-only row per (app_id, key, version) of a configuration item.
-- - Kill switches stay as keys in app.config_items (no kill_switches table; ruling 1).
-- - version mirrors config_items.version (CHECK version >= 1, same as config_items).
-- - updated_by is the actor name snapshot at write time; updated_by_admin_id has the type of
--   app.admin_users.id and is NULL for system / migration / seed writes. reason is optional.
-- - No foreign key to app.config_items (ruling 3): history outlives the current row. No foreign key
--   to app.admin_users either: updated_by / updated_by_admin_id are snapshots, not references.
-- - key has no shape CHECK because app.config_items has none.
-- - created_at is written from the injected Clock by the application; now() is only the fallback
--   default. The backfill below copies config_items.updated_at into it.
-- No trigger is added (db/AGENTS.md rule 8); append-only is enforced by grants.
--
-- Grants: couli_app gets SELECT and INSERT only (no UPDATE / DELETE / TRUNCATE: append-only).
-- couli_readonly and couli_payout get SELECT. couli_maint gets nothing.
--
-- Backfill: every existing config_items row becomes the history row of its current version
-- (value and updated_by copied, updated_by_admin_id and reason NULL, created_at = updated_at).
-- Rows written later by db/seeds run after migrations and get no history row here (known; handled
-- by the API task). ON CONFLICT keeps the statement safe to re-run.
--
-- Timeouts: a new, empty table is created and app.config_items (a small key/value table) is read
-- once; 5s lock wait so a blocked deploy fails fast, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.config_item_versions (
  app_id               text NOT NULL,
  key                  text NOT NULL,
  version              integer NOT NULL,
  value                jsonb NOT NULL,
  updated_by           text NOT NULL,
  updated_by_admin_id  uuid,
  reason               text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT config_item_versions_pkey PRIMARY KEY (app_id, key, version),
  CONSTRAINT config_item_versions_version_check CHECK (version >= 1)
);

GRANT SELECT, INSERT ON app.config_item_versions TO couli_app;
GRANT SELECT ON app.config_item_versions TO couli_readonly;
-- ADR-0001 §4.2 #20: payout reads its configuration directly from PostgreSQL.
GRANT SELECT ON app.config_item_versions TO couli_payout;

INSERT INTO app.config_item_versions
  (app_id, key, version, value, updated_by, updated_by_admin_id, reason, created_at)
SELECT app_id, key, version, value, updated_by, NULL, NULL, updated_at
FROM app.config_items
ON CONFLICT (app_id, key, version) DO NOTHING;
