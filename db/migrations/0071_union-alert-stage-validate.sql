-- Up Migration
-- Validates union_accounts_alert_stage_check, added NOT VALID by the previous migration
-- (union-auth-expiry: none / expired / d<N> for N = 1–999, 12 §9 T-05; BR-ID-24). Task B1-22a.
-- Precedent 0057 / 0058: a funds / attribution table takes no squawk exception, so the
-- validation of a rebuilt constraint is its own migration.
-- Compatibility: no shape change; existing rows are checked, not rewritten. Every value the old
-- five-value CHECK allowed (none, d14, d7, d1, expired) satisfies the new one, so no row can fail.
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration.
--
-- The migration runner (packages/db/scripts/migrate.ts) applies all pending migrations in one
-- transaction, so when both are deployed together the validation runs under the ACCESS EXCLUSIVE
-- lock the previous migration took; union_accounts holds one row per platform account, so the
-- scan is instant.
--
-- Timeouts: VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock and scans union_accounts; 5s
-- lock wait so a blocked deploy fails fast, 60s overall as a ceiling for the scan.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.union_accounts VALIDATE CONSTRAINT union_accounts_alert_stage_check;
