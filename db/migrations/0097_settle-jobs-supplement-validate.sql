-- Up Migration
-- Validates settle_jobs_job_check, rebuilt NOT VALID by the previous migration (settle-jobs-supplement:
-- the 0066 job values plus 'supplement'; D10-280 ①). Task B2-04rb.
-- Precedent 0057 / 0058, 0071 / 0072, 0077 / 0078: a funds table takes no squawk exception, so the
-- validation of a rebuilt constraint is its own migration.
-- Compatibility: no shape change; existing rows are checked, not rewritten. Every value the old
-- four-value CHECK allowed satisfies the new one, so no row can fail.
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration.
--
-- The migration runner (packages/db/scripts/migrate.ts) applies all pending migrations in one
-- transaction, so when both are deployed together the validation runs under the ACCESS EXCLUSIVE
-- lock the previous migration took; settle_jobs holds a few rows per job, platform and run, so the
-- scan is short.
--
-- Timeouts: VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock and scans app.settle_jobs; 5s
-- lock wait so a blocked deploy fails fast, 60s overall as a ceiling for the scan.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.settle_jobs VALIDATE CONSTRAINT settle_jobs_job_check;
