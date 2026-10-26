-- Up Migration
-- payout_account_changes.limit_exempt_reason (规划/04 §3.2, 2026-10-24; 规划/08 BR-WDR-02 细则「实名更正后的
-- 失效与重绑」; orchestrator D10-330). Task B2-05j (task brief §9.1). Storage only: identity's
-- payout-account service skips rows with a reason when it counts the month's changes, and its
-- invalidation port (used by the customer-service realname correction, B1-27g) writes the reason.
-- Compatibility: additive; one nullable text column without default (catalog-only, no rewrite) and
-- one CHECK. Nothing is dropped, renamed or retyped; the append-only trigger and the grants (couli_app
-- SELECT / INSERT, couli_readonly SELECT; no UPDATE / DELETE for anyone) are unchanged, so the new
-- column can only be written at insert.
--   payout_account_changes.limit_exempt_reason  text NULL. NULL: an ordinary change (counted
--     against withdraw.payout_account_change_per_month). 'realname_correction': the row records a
--     payout account the realname correction invalidated (new_payout_method = the old method,
--     new_hmac = '' — no new account); such rows are not counted. The user's first rebinding after
--     the invalidation is a first binding (no current row) and writes no change row at all.
--   payout_account_changes_limit_exempt_reason_check  NULL or 'realname_correction'. Added NOT VALID
--     (new rows are checked at once): a VALIDATE in the same transaction is refused by squawk
--     (constraint-missing-not-valid) and payout_account_changes, a funds / attribution table
--     (tools/ci/lint-migrations.ts), takes no squawk exception; the next migration validates it
--     (precedent 0079 / 0080). The column is new and NULL everywhere, so no row can violate it.
-- Grants: unchanged (table-level SELECT / INSERT of couli_app cover the new column; no UPDATE grant
-- exists on this table, column-level or otherwise).
-- Recovery: restore from backup; no down migration. (Undoing it would be a later migration that,
-- once nothing reads or writes it, drops the constraint and the column.)
--
-- Timeouts: ADD COLUMN without default and ADD CONSTRAINT ... NOT VALID are catalog-only but take
-- ACCESS EXCLUSIVE on app.payout_account_changes, held to commit (the runner uses one transaction);
-- 5s lock wait so a blocked deploy fails fast instead of queueing requests behind it, 30s overall.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.payout_account_changes ADD COLUMN limit_exempt_reason text;

ALTER TABLE app.payout_account_changes ADD CONSTRAINT payout_account_changes_limit_exempt_reason_check
  CHECK (limit_exempt_reason IS NULL OR limit_exempt_reason = 'realname_correction') NOT VALID;
