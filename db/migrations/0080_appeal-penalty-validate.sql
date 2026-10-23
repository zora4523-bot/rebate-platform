-- Up Migration
-- Validates appeals_penalty_started_at_check, added NOT VALID by the previous migration
-- (appeal-penalty: only an account appeal carries penalty_started_at; BR-ID-36, D10-147). Task B1-03v.
-- Precedent 0057 / 0058, 0071 / 0072: a funds / attribution table takes no squawk exception, so the
-- validation of a new constraint is its own migration.
-- Compatibility: no shape change; existing rows are checked, not rewritten. The column was added
-- by the previous migration and is NULL in every existing row, so no row can fail.
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration.
--
-- The migration runner (packages/db/scripts/migrate.ts) applies all pending migrations in one
-- transaction, so when both are deployed together the validation runs under the ACCESS EXCLUSIVE
-- lock the previous migration took.
--
-- Timeouts: VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock and scans app.appeals; 5s lock
-- wait so a blocked deploy fails fast, 60s overall as a ceiling for the scan.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.appeals VALIDATE CONSTRAINT appeals_penalty_started_at_check;
