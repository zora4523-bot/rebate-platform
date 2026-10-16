-- Up Migration
-- Product favorites (规划/04 §3.2 favorites: id、user_id、platform、product_key、created_at;
-- 唯一 (app_id, user_id, platform, product_key); 只存商品引用与时间，不存价格、链接、口令
-- (规划/01 F-PROD-12, 规划/07 §3); 用户删除即物理删除，注销完成时随账号删除 (08 BR-ID-30 细则 ⑱);
-- 写者 catalog). Table shape follows the orchestrator ruling in couli-runs/B1-28a brief §B.
-- Task B1-28a.
-- Compatibility: additive. One new ordinary (non-partitioned) table in schema app; no existing
-- object changes. Recovery: restore from backup; no down migration.
--
-- favorites: one row per (app_id, user_id, platform, product_key).
-- - id is a UUIDv7 supplied by the application; no default (db/AGENTS.md rule 6).
-- - user_id has the type of app.users.id but no foreign key: rows are physically deleted by the
--   application when the user removes a favorite or when account deletion completes, never by
--   cascade (db/AGENTS.md rule 7), and no tombstone user_id is kept.
-- - created_at is written from the injected Clock; now() is only the fallback default.
-- - No price, link, password or link_id column: the table stores the product reference and time
--   only. The per-user cap (favorites.max_per_user) and idempotent responses are application
--   rules (task B1-28b), not enforced here.
-- - favorites_app_id_user_id_created_at_id_idx serves the list ordered by favorite time, newest
--   first, with id as the keyset tiebreaker.
-- No trigger is added (db/AGENTS.md rule 8).
--
-- Grants: couli_app gets SELECT, INSERT and DELETE (no UPDATE: a favorite is never edited, only
-- removed and re-added; no TRUNCATE). couli_readonly gets SELECT. No other role (couli_payout,
-- couli_maint) gets any privilege.
--
-- Timeouts: only a new, empty table with its constraints and one index is created, and no
-- existing table is locked; 5s lock wait so a blocked deploy fails fast, 30s overall as a
-- ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.favorites (
  id uuid NOT NULL,
  app_id text NOT NULL,
  user_id uuid NOT NULL,
  platform text NOT NULL,
  product_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT favorites_pkey PRIMARY KEY (id),
  CONSTRAINT favorites_app_id_user_id_platform_product_key_key
    UNIQUE (app_id, user_id, platform, product_key)
);

CREATE INDEX favorites_app_id_user_id_created_at_id_idx
  ON app.favorites (app_id, user_id, created_at DESC, id);

GRANT SELECT, INSERT, DELETE ON app.favorites TO couli_app;
GRANT SELECT ON app.favorites TO couli_readonly;
