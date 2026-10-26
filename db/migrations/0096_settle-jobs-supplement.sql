-- Up Migration
-- settle_jobs_job_check widened to admit 'supplement' (orchestrator ruling D10-280 ①, task B2-04rb):
-- the supplementary batch of BR-FUND-04 ⑧ (B2-04r) records its runs under its own job name instead
-- of reusing 'bill'. Storage only: no column, index, trigger or grant changes.
-- Compatibility: relaxing only. The CHECK is dropped and added back under the same name with the
-- 0066 values (bill, settle_adjust, recon_union, recon_monthly) plus 'supplement'; every existing
-- row satisfies the old four-value CHECK and therefore the new one, so no row can fail. The other
-- settle_jobs constraints (pkey, run_key, platform / status / finished / counts checks) are
-- untouched, so a supplement rerun at the same nominal run_at is still deduplicated by
-- settle_jobs_run_key.
-- It is added NOT VALID: new rows and updates are checked at once; validating it is the next
-- migration (precedent 0057 / 0058, 0071 / 0072, 0077 / 0078), because a VALIDATE in the same
-- transaction is refused by squawk (constraint-missing-not-valid) and settle_jobs, a funds table,
-- takes no squawk exception.
-- Guard: settle_jobs is a funds table (settlement); its job CHECK is rebuilt under the same name
-- with a different definition, so this file must be registered by name and sha256 in
-- APPROVED_GUARD_CHANGES of tools/ci/lint-migrations.ts (guard-change task B2-04rc). Any later
-- edit of this file needs a new registration.
-- Grants: unchanged (0066: couli_app cannot UPDATE job).
-- Recovery: restore from backup; no down migration. (Narrowing back would be a new migration that,
-- after the application stops writing 'supplement' and those rows are dealt with, restores the
-- four-value CHECK.)
--
-- Timeouts: DROP / ADD CONSTRAINT (NOT VALID, no scan) take ACCESS EXCLUSIVE on app.settle_jobs,
-- held to commit (the runner uses one transaction); both are catalog changes. 5s lock wait so a
-- blocked deploy fails fast instead of queueing settlement jobs behind it; 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.settle_jobs DROP CONSTRAINT settle_jobs_job_check;

ALTER TABLE app.settle_jobs ADD CONSTRAINT settle_jobs_job_check
  CHECK (job IN ('bill', 'settle_adjust', 'recon_union', 'recon_monthly', 'supplement')) NOT VALID;
