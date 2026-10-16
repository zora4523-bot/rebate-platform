-- Up Migration
-- Apple refresh token, Apple revocation mark and session login method (规划/04 §3.2 user_oauth and
-- sessions, 2026-10-06 additions, 规划/12 §9 A-08, A-09; BR-ID-04, BR-ID-27). Task B1-02w.
-- Compatibility: additive. Three nullable columns without defaults (old writers that omit them stay
-- valid) and two named CHECKs. No backfill: existing rows keep NULL in every new column.
-- No grant changes (see Grants below). No triggers, no procedural SQL.
-- Recovery: restore from backup; no down migration.
--
-- user_oauth.apple_refresh_token_cipher: the field-encrypted Apple refresh_token obtained at login,
-- kept for revocation on account deletion (BR-ID-04 last sentence, BR-ID-27). Only provider = apple
-- may hold a value (04 §3.2), hence user_oauth_apple_refresh_token_provider_check, which also stops a
-- row with a ciphertext from having its provider changed away from apple. bytea like the other
-- ciphertext columns (users.phone_cipher, union_credentials.refresh_token_cipher).
-- user_oauth.revoked_at: set when Apple reports revocation or account deletion; the row is kept and
-- the column is cleared again on reauthorization with the same Apple account. No CHECK.
--
-- sessions.login_method: how the session was established, values as login_logs.method plus merge
-- (BR-ID-37, 04 §3.2). Written once on INSERT; a refresh does not change it. Existing sessions stay
-- NULL (no backfill); NULL passes the CHECK.
--
-- Grants: none. user_oauth has table-level SELECT / INSERT / UPDATE / DELETE for couli_app and
-- table-level SELECT for couli_readonly (0005), which cover both new columns (reauthorization needs
-- UPDATE on them). sessions has table-level SELECT and INSERT for couli_app, column-level UPDATE
-- only on revoked_at, revoke_reason, updated_at, and table-level SELECT for couli_readonly (0013):
-- couli_app can write login_method on INSERT and can never change it afterwards, as intended.
--
-- Validation without NOT VALID: every existing row has the new columns NULL, so the CHECK scans
-- find no violation, and neither table holds real rows before launch.
--
-- Timeouts: each ALTER TABLE takes an ACCESS EXCLUSIVE lock on a small table; 5s lock wait so a
-- blocked deploy fails fast instead of queueing logins behind it, 60s overall as a ceiling for the
-- two CHECK scans.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.user_oauth
  ADD COLUMN apple_refresh_token_cipher bytea,
  ADD COLUMN revoked_at timestamptz;

-- Every existing row has apple_refresh_token_cipher NULL and there are no real rows before launch:
-- validating immediately is instant.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.user_oauth ADD CONSTRAINT user_oauth_apple_refresh_token_provider_check CHECK (apple_refresh_token_cipher IS NULL OR provider = 'apple');

ALTER TABLE app.sessions ADD COLUMN login_method text;

-- Every existing row has login_method NULL and there are no real rows before launch: validating
-- immediately is instant.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.sessions ADD CONSTRAINT sessions_login_method_check CHECK (login_method IN ('sms', 'wechat', 'apple', 'huawei', 'merge'));
