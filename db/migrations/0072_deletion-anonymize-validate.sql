-- Up Migration
-- Validates payout_accounts_details_check and realname_unverified_cleared_check, rebuilt NOT VALID
-- by 0071 (account-deletion anonymization; orchestrator rulings D10-186, D10-137 ②; task B1-15r).
-- Compatibility: no shape change; existing rows are checked, not rewritten. Every existing row has
-- anonymized_at NULL and tax_retained false, where both checks equal their earlier definitions, so
-- the scan finds nothing; a violating row would fail this migration and block the deploy.
-- Recovery: restore from backup; no down migration.
--
-- Same shape as 0058: the runner applies every migration in one transaction, so the scan runs
-- under the ACCESS EXCLUSIVE locks 0071 already holds; both tables are small before launch.
--
-- Timeouts: VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock and scans the table; 5s lock
-- wait so a blocked deploy fails fast, 60s overall as a ceiling for the two scans.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.payout_accounts VALIDATE CONSTRAINT payout_accounts_details_check;

ALTER TABLE app.realname VALIDATE CONSTRAINT realname_unverified_cleared_check;
