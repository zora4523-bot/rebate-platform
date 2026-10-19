-- Up Migration
-- Landing-page registrations: the PG-authoritative per-IP account count of the invite landing page
-- (规划/08 BR-ID-32 同 IP 注册上限 landing.ip_register_limit, BR-INV-05 校验顺序). Task B1-11h
-- (orchestrator ruling §9.2 第 5 条, §9.3; same PG-authoritative pattern as 0052 / couli #150).
-- Compatibility: additive. One new ordinary table in schema app with named constraints, one index
-- and grants; no existing object changes.
-- Recovery: restore from backup; no down migration.
--
-- One row per account created by POST /v1/invites/landing-register, written by identity only, in
-- the same transaction as the account (users), its two consent records and its relation change:
-- a rolled-back registration leaves no row, so already_registered answers, failed requests and
-- rolled-back registrations are never counted.
--   user_id: the account created (one row per account; foreign key to users (app_id, id)).
--   ip_hmac: keyed blind index (64 lowercase hex) of the client IP; never the clear value.
--   created_at: the injected Clock at the registration decision (no database default: the count
--     window is measured on it).
-- Count: rows of (app_id, ip_hmac) with created_at in [now − 3600 s, now] (both ends closed); the
-- row is inserted under a transaction-level advisory lock on (app_id, ip_hmac) taken before the
-- count, so the count never exceeds the limit. Rows are never updated or deleted by the
-- application.
-- Retention: TODO(规划/11 §7.1): no purge job yet — blocked on a BR-ID-30 retention period for this
-- table (rows are kept; only the last hour is ever read).
--
-- Grants: couli_app SELECT and INSERT only (append-only: no UPDATE, DELETE, TRUNCATE, REFERENCES
-- or TRIGGER for anyone). couli_readonly SELECT.
--
-- Timeouts: a new empty table, its foreign key to users (a SHARE ROW EXCLUSIVE lock on users while
-- the constraint is added) and one index; 5s lock wait so a blocked deploy fails fast, 30s overall
-- as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.landing_registrations (
  app_id      text        NOT NULL,
  user_id     uuid        NOT NULL,
  ip_hmac     text        NOT NULL,
  created_at  timestamptz NOT NULL,
  CONSTRAINT landing_registrations_pkey PRIMARY KEY (app_id, user_id),
  CONSTRAINT landing_registrations_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT landing_registrations_ip_hmac_check CHECK (ip_hmac ~ '^[0-9a-f]{64}$')
);

CREATE INDEX landing_registrations_ip_created_idx
  ON app.landing_registrations (app_id, ip_hmac, created_at);

GRANT SELECT, INSERT ON app.landing_registrations TO couli_app;
GRANT SELECT ON app.landing_registrations TO couli_readonly;
