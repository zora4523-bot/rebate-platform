-- Up Migration
-- Validates payout_account_changes_limit_exempt_reason_check, added NOT VALID by the previous
-- migration (payout-account-changes-limit-exempt: NULL or 'realname_correction'; 规划/08 BR-WDR-02
-- 细则「实名更正后的失效与重绑」, D10-330). Task B2-05j.
-- Precedent 0079 / 0080: a funds / attribution table takes no squawk exception, so the validation of
-- a new constraint is its own migration.
-- Compatibility: no shape change; existing rows are checked, not rewritten. The column was added by
-- the previous migration and is NULL in every existing row, so no row can fail.
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration.
--
-- The migration runner (packages/db/scripts/migrate.ts) applies all pending migrations in one
-- transaction, so when both are deployed together the validation runs under the ACCESS EXCLUSIVE
-- lock the previous migration took.
--
-- Timeouts: VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock and scans
-- app.payout_account_changes; 5s lock wait so a blocked deploy fails fast, 60s overall for the scan.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.payout_account_changes VALIDATE CONSTRAINT payout_account_changes_limit_exempt_reason_check;
