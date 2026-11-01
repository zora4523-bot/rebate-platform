-- Up Migration
-- Validates export_tasks_resource_check, re-added NOT VALID by the previous migration
-- (export-tasks-tax-withdrawals: BR-WDR-21, CT-24zi; task B2-08e). Precedent 0113 / 0114.
-- Compatibility: no shape change; existing rows are checked, not rewritten. The new CHECK is wider
-- than the one it replaced, so no row can fail.
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration.
--
-- The migration runner (packages/db/scripts/migrate.ts) applies all pending migrations in one
-- transaction, so when both are deployed together the validation runs under the ACCESS EXCLUSIVE
-- lock the previous migration took.
--
-- Timeouts: VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock and scans app.export_tasks; 5s
-- lock wait so a blocked deploy fails fast, 60s overall as a ceiling for the scan.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.export_tasks VALIDATE CONSTRAINT export_tasks_resource_check;
