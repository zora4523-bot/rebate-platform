-- Up Migration
-- Reverify storage for a recycled phone number (08 BR-WDR-01 细则「旧手机号被二次放号时的提现加验」;
-- task B1-02zo, storage only: the session-time flagging and the reverify endpoints are B1-02zp /
-- B1-02zq, deletion clean-up is B1-02zr). The withdraw.dormant_reverify_days switch is seeded as 0
-- (off) in db/seeds/0001_config-defaults.sql until all three clients ship the reverify page.
-- Compatibility: additive. Six nullable / defaulted columns on app.users and one new empty table
-- with named constraints and grants; no existing object changes, no backfill.
-- Recovery: restore from backup; no down migration.
--
-- app.users (writer: identity, couli_app; the existing table-level grants of 0005 already cover
-- the new columns, so no column grant is added):
--   last_active_at          the account's last activity, overwritten on every login / refresh
--                           (the check does not depend on login_logs).
--   last_login_device_hash  the device_hash of the last login, overwritten the same way.
--   reverify_flagged_at     non-null = pending reverify; the instant the flag was set (from the
--                           injected Clock, no database default). An existing flag is not re-judged.
--   reverify_trusted        the trusted-identity snapshot fixed when the flag is set:
--                           {"realname": boolean, "providers": [text, …]}; null when not flagged.
--   reverify_fail_count     self-service reverify failures of the account on reverify_fail_day.
--   reverify_fail_day       the +08:00 day reverify_fail_count belongs to (packages/domain decides
--                           the day; no SQL clock).
--
-- app.reverified_devices: one row per device that passed reverify (long-lived; the account flag
--   stays). source: self (self-service pass) or admin. (app_id, user_id) points to users (app_id,
--   id) with no cascade; the unique key (app_id, user_id, device_hash) also serves that lookup.
--   Rows are never updated; deletion processing removes them (B1-02zr).
-- Grants: couli_app SELECT, INSERT, DELETE; couli_readonly SELECT; no other role.
--
-- Timeouts: ADD COLUMN takes an ACCESS EXCLUSIVE lock on app.users, held to commit (the runner
-- uses one transaction); the constant default is catalog only and the inline CHECKs scan a table
-- that holds no real rows before launch. The new table and its constraints are catalog work plus a
-- SHARE ROW EXCLUSIVE lock on users for the foreign key. 5s lock wait so a blocked deploy fails
-- fast instead of queueing logins behind it, 60s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.users
  ADD COLUMN last_active_at timestamptz,
  ADD COLUMN last_login_device_hash text
    CONSTRAINT users_last_login_device_hash_check
      CHECK (last_login_device_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN reverify_flagged_at timestamptz,
  ADD COLUMN reverify_trusted jsonb
    CONSTRAINT users_reverify_trusted_check
      CHECK (
        jsonb_typeof(reverify_trusted) = 'object'
        AND jsonb_typeof(reverify_trusted -> 'realname') = 'boolean'
        AND jsonb_typeof(reverify_trusted -> 'providers') = 'array'
      ),
  ADD COLUMN reverify_fail_count integer NOT NULL DEFAULT 0
    CONSTRAINT users_reverify_fail_count_check CHECK (reverify_fail_count >= 0),
  ADD COLUMN reverify_fail_day date;

CREATE TABLE app.reverified_devices (
  id          uuid NOT NULL,
  app_id      text NOT NULL,
  user_id     uuid NOT NULL,
  device_hash text NOT NULL,
  source      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reverified_devices_pkey PRIMARY KEY (id),
  CONSTRAINT reverified_devices_user_device_key UNIQUE (app_id, user_id, device_hash),
  CONSTRAINT reverified_devices_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT reverified_devices_app_id_check CHECK (app_id <> ''),
  CONSTRAINT reverified_devices_device_hash_check CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT reverified_devices_source_check CHECK (source IN ('self', 'admin'))
);

GRANT SELECT, INSERT, DELETE ON app.reverified_devices TO couli_app;
GRANT SELECT ON app.reverified_devices TO couli_readonly;
