-- Up Migration
-- Validates withdrawals_batch_fkey (withdrawals.batch_id → payout_batches.id), added NOT VALID by
-- the previous migration (payout core tables, BR-WDR-11 / BR-WDR-12). Task B2-06a.
-- Precedent 0071 / 0072: a funds table takes no squawk exception, so the validation of a foreign key
-- added to an existing table is its own migration.
-- Compatibility: no shape change; existing rows are checked, not rewritten. Before the payout core
-- tables exist no withdrawal carries a batch_id (B2-05b left it unreferenced), so no row can fail.
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration.
--
-- The migration runner (packages/db/scripts/migrate.ts) applies all pending migrations in one
-- transaction, so when both are deployed together the validation runs under the locks the previous
-- migration took; withdrawals holds no real rows before launch, so the scan is instant.
--
-- Timeouts: VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock on withdrawals and a ROW SHARE
-- lock on payout_batches and scans withdrawals; 5s lock wait so a blocked deploy fails fast, 60s
-- overall as a ceiling for the scan.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.withdrawals VALIDATE CONSTRAINT withdrawals_batch_fkey;
