-- Up Migration
-- Validates ledger_entries_ledger_type_check and recon_diffs_type_check, rebuilt NOT VALID by the
-- previous migration (ledger-type-pay: + PAY_RECEIPT / PAY_REFUND / PAY_ANOMALY / PAY_FEE, + pay_mismatch /
-- pay_anomaly; 规划/08 BR-PAY-07; D10-168 ①). Task B2-15i.
-- Precedent 0057 / 0058, 0071 / 0072, 0079 / 0080: a funds table takes no squawk exception, so the
-- validation of a rebuilt constraint is its own migration.
-- Compatibility: no shape change; existing rows are checked, not rewritten. Both CHECKs only widen
-- (every former value is still listed), so no existing row can fail. On the partitioned
-- ledger_entries the validation recurses to its partitions (only the DEFAULT partition exists).
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration.
--
-- The migration runner (packages/db/scripts/migrate.ts) applies all pending migrations in one
-- transaction, so when both are deployed together the validation runs under the ACCESS EXCLUSIVE
-- lock the previous migration took.
--
-- Timeouts: VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock and scans the rows, which are few
-- before launch; 5s lock wait so a blocked deploy fails fast, 60s overall as a ceiling for the scans.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.ledger_entries VALIDATE CONSTRAINT ledger_entries_ledger_type_check;

ALTER TABLE app.recon_diffs VALIDATE CONSTRAINT recon_diffs_type_check;
