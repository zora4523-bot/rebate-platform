-- Up Migration
-- Same-device multi-account check (BR-ID-37; owner rulings in task B1-03k §9.4 ① ②). Task B1-03k.
-- Compatibility: additive. One nullable column without a default on login_logs (old writers that omit
-- it stay valid), its format CHECK, one index on login_logs and one partial unique index on risk_hits.
-- No grant changes (see Grants below).
-- Recovery: restore from backup; no down migration.
--
-- login_logs.device_hash: the device_hash of the devices row the login was verified on (the same
-- value as devices.device_hash, so the same format CHECK as devices_device_hash_check). Written by
-- identity from this release on; existing rows stay NULL and are not backfilled (device_id_hash is
-- not reversible, and there are no real rows before launch). Rows with NULL take no part in the
-- check. BR-ID-37 ranks, per (app_id, device_hash), each account's first successful login inside
-- the sliding window, hence login_logs_device_created_idx (app_id, device_hash, created_at).
--
-- risk_hits_same_device_once_key: a same-device hit is written once per (app_id, rule_id, ref_type,
-- ref_id, value_hmac), so a repeated or concurrent check of the same withdrawal adds no rows (hard
-- rule 4: idempotency ends on a PG unique constraint). Partial on rule_id so the other rules'
-- hits (several hits of one rule on one blocked request are legitimate there) are unaffected.
--
-- Grants: none needed. login_logs has table-level SELECT and INSERT for couli_app and table-level
-- SELECT for couli_readonly (0005), which cover the new column; risk_hits gets no new column.
--
-- Validation without NOT VALID: the new column is NULL on every existing row, so the CHECK scan
-- finds no violation, and login_logs holds no real rows before launch.
--
-- Timeouts: ALTER TABLE takes an ACCESS EXCLUSIVE lock on login_logs, CREATE INDEX a SHARE lock on
-- login_logs and risk_hits; 5s lock wait so a blocked deploy fails fast instead of queueing logins
-- behind it, 60s overall as a ceiling for the CHECK scan and two index builds on small tables.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.login_logs ADD COLUMN device_hash text;

-- Every existing row has device_hash NULL and there are no real rows before launch: validating
-- immediately is instant.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.login_logs ADD CONSTRAINT login_logs_device_hash_check CHECK (device_hash ~ '^[0-9a-f]{64}$');

CREATE INDEX login_logs_device_created_idx
  ON app.login_logs (app_id, device_hash, created_at)
  WHERE device_hash IS NOT NULL;

CREATE UNIQUE INDEX risk_hits_same_device_once_key
  ON app.risk_hits (app_id, rule_id, ref_type, ref_id, value_hmac)
  WHERE rule_id = 'SAME_DEVICE_MULTI_ACCOUNT';
