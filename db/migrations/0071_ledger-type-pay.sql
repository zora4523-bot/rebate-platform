-- Up Migration
-- Payment voucher types and payment reconciliation diff types (规划/08 BR-PAY-07 账务隔离与对账;
-- orchestrator ruling D10-168 ①; independent review S1-1). Task B2-15i, depends on B2-15h (guard
-- registration) and B2-02c.
--   ledger_entries_ledger_type_check: the 13 user ledger types of BR-FUND-15 (0037, same order,
--     unchanged) plus the four pay_ledger_type values PAY_RECEIPT, PAY_REFUND, PAY_ANOMALY,
--     PAY_FEE. These are used only on platform subjects (CASH_PAY:{pay_channel},
--     PAY_RECEIPTS:{biz_type}, PAY_SUSPENSE, PAY_CHANNEL_FEE); they are not user ledger types, never
--     appear in any user ledger interface, and BR-FUND-15 itself is unchanged. Which subjects and
--     amounts the payment vouchers carry belongs to B2-15c, not here.
--   recon_diffs_type_check: the 9 types of 0060 (same order, unchanged) plus pay_mismatch and
--     pay_anomaly, the payment reconciliation diffs of source R4 (already allowed by
--     recon_diffs_source_check).
-- Compatibility: both CHECKs only widen; every existing row and writer stays valid. Each is dropped
-- and added back under the same name NOT VALID, then validated in this same migration. On the
-- partitioned ledger_entries the drop, add and validation recurse to its partitions (only the
-- DEFAULT partition exists). No column, index, trigger or grant changes.
-- Guard: ledger_entries and recon_diffs are funds tables; both CHECKs are rebuilt under the same
-- name with a different definition, so this file is registered by hash in APPROVED_GUARD_CHANGES of
-- tools/ci/lint-migrations.ts (task B2-15h). Any later edit of this file needs a new registration.
-- Recovery: restore from backup; no down migration. Narrowing the CHECKs back is a new migration and
-- fails while any PAY_* entry or pay_* diff exists.
--
-- Timeouts: DROP / ADD CONSTRAINT take an ACCESS EXCLUSIVE lock on ledger_entries (and its
-- partition) and on recon_diffs; VALIDATE takes SHARE UPDATE EXCLUSIVE and scans the rows, which are
-- few before launch. 5s lock wait so a blocked deploy fails fast, 60s overall as a ceiling for the
-- scans.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.ledger_entries DROP CONSTRAINT ledger_entries_ledger_type_check;

ALTER TABLE app.ledger_entries
  ADD CONSTRAINT ledger_entries_ledger_type_check CHECK (ledger_type IN (
    'REBATE_CREDIT', 'SHARE_CREDIT', 'REFERRAL_CREDIT', 'CLAWBACK', 'SETTLE_ADJUST',
    'WITHDRAW_FREEZE', 'WITHDRAW_PAID', 'WITHDRAW_RETURN', 'WITHDRAW_FEE', 'TAX_WITHHOLD',
    'REWARD', 'ADMIN_ADJUST', 'BAD_DEBT_WRITEOFF',
    'PAY_RECEIPT', 'PAY_REFUND', 'PAY_ANOMALY', 'PAY_FEE'
  )) NOT VALID;

ALTER TABLE app.ledger_entries VALIDATE CONSTRAINT ledger_entries_ledger_type_check;

ALTER TABLE app.recon_diffs DROP CONSTRAINT recon_diffs_type_check;

ALTER TABLE app.recon_diffs
  ADD CONSTRAINT recon_diffs_type_check CHECK (type IN (
    'union_mismatch', 'channel_mismatch', 'ledger_mismatch', 'platform_restore',
    'month_end_unbalanced', 'settle_amount_mismatch', 'settle_missing', 'appeal_restore',
    'estimate_changed_after_credit',
    'pay_mismatch', 'pay_anomaly'
  )) NOT VALID;

ALTER TABLE app.recon_diffs VALIDATE CONSTRAINT recon_diffs_type_check;
