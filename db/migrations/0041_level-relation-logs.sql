-- Up Migration
-- Growth change logs app.relation_change_logs and app.level_change_logs (规划/04 §3.2 表行;
-- BR-INV-11 上下级历史只能由关系日志回放, BR-INV-14 paid_at 时刻的等级, BR-CALC-12 按 paid_at
-- 回放直推 / 间推受益人与等级; 规划/13 规范名 relation_change_logs、level_change_logs, i.e. 08's
-- user_relation_logs / user_level_logs; ADR-0001 §4). Task B1-11a. Writer: growth (B1-11b writes
-- a row in the same transaction as every users.parent_id / users.level change and reads them as of
-- a given instant).
-- Compatibility: additive (two new tables, their constraints, indexes, triggers and grants; nothing
-- existing changes, app.users is untouched). No backfill: accounts that already exist get no
-- register level row (not in production yet; replay falls back to L1 with an alert, BR-CALC-12,
-- in B1-11b). Recovery: restore from backup; no down migration.
--
-- Planning conflict and choice (orchestrator ruling B1-11a §9.3 #3, to be written back to 规划/04):
-- the shape follows 04 (from_ / to_ prefixes, operator, relation column `at`); a `source` column is
-- added from 08 (04 omits it). 08's before / after = from_level / to_level, new_parent_id =
-- to_parent_id, operator_id = operator. 08's "replay relation logs by created_at" is carried by the
-- business instant `at` (application Clock); created_at (DB now()) is only the insert stamp and is
-- never used for replay.
--
-- app.relation_change_logs, one row per change of users.parent_id:
--   id               bigint identity (insert order; tie-breaker for rows with the same `at`).
--   app_id, user_id  the user whose parent changed (FK app.users (app_id, id)).
--   from_parent_id   parent before the change, NULL = had no parent (FK, same app).
--   to_parent_id     parent after the change, NULL = no parent any more (FK, same app); never the
--                    user itself; always NULL for source = parent_deleted (BR-INV-11: the parent's
--                    deletion reached done and the direct children are detached).
--   source           landing / register / backfill / admin / risk_same_device / parent_deleted
--                    (BR-INV-11).
--   operator         opaque non-blank audit identity (precedent 0009), not an enum.
--   reason           optional free text.
--   at               business instant of the change (application Clock, no SQL default).
--   created_at       insert stamp (DB now()).
--   A row always records a change: from_parent_id IS DISTINCT FROM to_parent_id (two NULLs refused).
--
-- app.level_change_logs, one row per change of users.level:
--   id               bigint identity (tie-breaker for rows with the same effective_at).
--   app_id, user_id  the user (FK app.users (app_id, id)).
--   from_level       level before, NULL only for source = register (04 §2.5 user_level L1/L2/L3).
--   to_level         level after (L1/L2/L3).
--   source           register (registration, from_level NULL; at most one per account, partial
--                    unique index, so the register write is idempotent in PG) / admin (manual
--                    adjustment in the admin console, from_level set and different, reason
--                    required, BR-INV-14). Automatic promotion (P1) adds its value in a later
--                    migration.
--   operator, reason as above (reason required and non-blank for admin).
--   effective_at     instant the new level takes effect (application Clock, no SQL default).
--   created_at       insert stamp (DB now()).
--
-- Reads (B1-11b): state as of T = the row with at / effective_at <= T ORDER BY at / effective_at
-- DESC, id DESC LIMIT 1 for (app_id, user_id) (equal instant takes the new value); no row = no
-- parent / registration default. Served by the indexes (app_id, user_id, at|effective_at, id).
--
-- Immutability (db/AGENTS.md rules 4 and 8, precedent 0003 audit / event tables): couli_app gets
-- SELECT and INSERT only, couli_readonly SELECT only; a BEFORE UPDATE OR DELETE row trigger running
-- the shared app.reject_update_delete() (0003, restrict_violation) refuses changes by every role,
-- the owner included. The identity sequence needs no grant (GENERATED ALWAYS uses it internally).
-- All constraints and indexes are named.
--
-- Timeouts: two new empty tables; CREATE TABLE / INDEX are instant, but the foreign keys take
-- SHARE ROW EXCLUSIVE on app.users. 5s lock wait so a blocked deploy fails fast instead of queueing
-- traffic behind it, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.relation_change_logs (
  id             bigint GENERATED ALWAYS AS IDENTITY,
  app_id         text NOT NULL,
  user_id        uuid NOT NULL,
  from_parent_id uuid,
  to_parent_id   uuid,
  source         text NOT NULL,
  operator       text NOT NULL,
  reason         text,
  at             timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT relation_change_logs_pkey PRIMARY KEY (id),
  CONSTRAINT relation_change_logs_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT relation_change_logs_from_parent_fkey FOREIGN KEY (app_id, from_parent_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT relation_change_logs_to_parent_fkey FOREIGN KEY (app_id, to_parent_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT relation_change_logs_source_check CHECK (
    source IN ('landing', 'register', 'backfill', 'admin', 'risk_same_device', 'parent_deleted')
  ),
  CONSTRAINT relation_change_logs_change_check
    CHECK (from_parent_id IS DISTINCT FROM to_parent_id),
  CONSTRAINT relation_change_logs_not_self_check
    CHECK (to_parent_id IS NULL OR to_parent_id <> user_id),
  CONSTRAINT relation_change_logs_parent_deleted_check
    CHECK (source <> 'parent_deleted' OR to_parent_id IS NULL),
  CONSTRAINT relation_change_logs_operator_check CHECK (btrim(operator) <> '')
);

CREATE INDEX relation_change_logs_user_at_idx
  ON app.relation_change_logs (app_id, user_id, at, id);

CREATE TRIGGER relation_change_logs_append_only
  BEFORE DELETE OR UPDATE ON app.relation_change_logs
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

CREATE TABLE app.level_change_logs (
  id           bigint GENERATED ALWAYS AS IDENTITY,
  app_id       text NOT NULL,
  user_id      uuid NOT NULL,
  from_level   text,
  to_level     text NOT NULL,
  source       text NOT NULL,
  operator     text NOT NULL,
  reason       text,
  effective_at timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT level_change_logs_pkey PRIMARY KEY (id),
  CONSTRAINT level_change_logs_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT level_change_logs_to_level_check CHECK (to_level IN ('L1', 'L2', 'L3')),
  CONSTRAINT level_change_logs_from_level_check CHECK (from_level IN ('L1', 'L2', 'L3')),
  CONSTRAINT level_change_logs_source_check CHECK (source IN ('register', 'admin')),
  CONSTRAINT level_change_logs_shape_check CHECK (
    (source = 'register' AND from_level IS NULL)
    OR (source = 'admin' AND from_level IS NOT NULL AND from_level <> to_level)
  ),
  CONSTRAINT level_change_logs_admin_reason_check
    CHECK (source <> 'admin' OR btrim(coalesce(reason, '')) <> ''),
  CONSTRAINT level_change_logs_operator_check CHECK (btrim(operator) <> '')
);

CREATE UNIQUE INDEX level_change_logs_register_key
  ON app.level_change_logs (app_id, user_id)
  WHERE source = 'register';

CREATE INDEX level_change_logs_user_effective_idx
  ON app.level_change_logs (app_id, user_id, effective_at, id);

CREATE TRIGGER level_change_logs_append_only
  BEFORE DELETE OR UPDATE ON app.level_change_logs
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

GRANT SELECT, INSERT ON app.relation_change_logs, app.level_change_logs TO couli_app;
GRANT SELECT ON app.relation_change_logs, app.level_change_logs TO couli_readonly;
