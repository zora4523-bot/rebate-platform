-- Up Migration
-- Validates appeals_source_check and appeals_registered_by_check, added NOT VALID by the previous
-- migration (appeals-console: the console's source and registrant; CT-24r, BR-ID-36). Task B1-03ze.
-- Precedent 0079 / 0080: a funds / attribution table takes no squawk exception, so the validation
-- of a new constraint is its own migration.
-- Compatibility: no shape change; existing rows are checked, not rewritten. The columns were added
-- by the previous migration: every existing row has source app (the default) and NULL
-- registered_by, so no row can fail.
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration.
--
-- The migration runner (packages/db/scripts/migrate.ts) applies all pending migrations in one
-- transaction, so when both are deployed together the validation runs under the ACCESS EXCLUSIVE
-- lock the previous migration took.
--
-- Timeouts: VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock and scans app.appeals; 5s lock
-- wait so a blocked deploy fails fast, 60s overall as a ceiling for the two scans.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.appeals VALIDATE CONSTRAINT appeals_source_check;

ALTER TABLE app.appeals VALIDATE CONSTRAINT appeals_registered_by_check;
