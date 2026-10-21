-- Up Migration
-- Per-account notification category switches app.notification_settings (contract
-- components.schemas.NotificationSettings; BR-WATCH-19 ③ per-category opt-out of service /
-- subscription / marketing messages; ADR-0001 §4). Task B1-12l (orchestrator ruling B in the
-- task brief: own table, writer notification).
-- Compatibility: additive (one new table, its constraints and grants; nothing existing changes,
-- app.users is only referenced; inbox_messages, notify_templates and notify_logs are untouched).
-- Recovery: no down migration. To roll back, a new migration drops app.notification_settings
-- after the application stops reading and writing it.
--
-- Writer: notification owns this table.
--
-- One row per (app_id, user_id) at most; the primary key makes a duplicate insert fail with
-- 23505 so concurrent first saves persist exactly one row. user_id references
-- app.users (app_id, id), no cascade. The three switches are boolean NOT NULL with no default:
-- no rows are seeded, and an account without a row reads all three as true in the reader
-- (contract: never-saved accounts return true), not here.
--
-- CAS (ADR-0001 §4.1): row_version starts at 0; writers compare and increment it in the same
-- UPDATE. Grants: couli_app SELECT, INSERT and column-level UPDATE on the three switches,
-- row_version and updated_at only (app_id, user_id and created_at are immutable); no DELETE.
-- couli_readonly SELECT only.
--
-- Timeouts: one new empty table; CREATE TABLE is instant, but the foreign key takes
-- SHARE ROW EXCLUSIVE on app.users. 5s lock wait so a blocked deploy fails fast instead of
-- queueing traffic behind it, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.notification_settings (
  app_id             text NOT NULL,
  user_id            uuid NOT NULL,
  service_push       boolean NOT NULL,
  subscription_push  boolean NOT NULL,
  marketing_push     boolean NOT NULL,
  row_version        integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_settings_pkey PRIMARY KEY (app_id, user_id),
  CONSTRAINT notification_settings_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id)
);

GRANT SELECT, INSERT,
  UPDATE (service_push, subscription_push, marketing_push, row_version, updated_at)
  ON app.notification_settings TO couli_app;
GRANT SELECT ON app.notification_settings TO couli_readonly;
