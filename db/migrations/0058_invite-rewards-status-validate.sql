-- Up Migration
-- Validates invite_rewards_status_check, added NOT VALID by 0057 (expired in place of
-- budget_exhausted; 规划/08 BR-INV-24 有效期). Task CT-25d (orchestrator ruling §9.2, D10-98).
-- Compatibility: no shape change; existing rows are checked, not rewritten. A row still holding
-- budget_exhausted makes this migration fail and blocks the deploy (none exists: the campaign is
-- off by default).
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration.
--
-- The migration runner (packages/db/scripts/migrate.ts) applies all pending migrations in one
-- transaction, so when 0057 and 0058 are deployed together the validation still runs in the same
-- transaction as the ACCESS EXCLUSIVE lock taken by 0057; the table holds no real rows before
-- launch, so the scan is instant.
--
-- Timeouts: VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock and scans invite_rewards; 5s
-- lock wait so a blocked deploy fails fast, 60s overall as a ceiling for the scan.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.invite_rewards VALIDATE CONSTRAINT invite_rewards_status_check;
