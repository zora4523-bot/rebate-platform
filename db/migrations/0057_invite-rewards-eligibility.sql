-- Up Migration
-- Invite reward eligibility period (#161 follow-up): app.invite_rewards gains the locked
-- eligibility period in days, and the status CHECK replaces budget_exhausted (no path left to it)
-- with expired (规划/04 §3.2 invite_rewards, 2026-10-20; 规划/08 BR-INV-24 有效期). Task CT-25d
-- (orchestrator ruling §9.2, D10-98). Codes are the ones of contract task CT-25c: qualified /
-- deferred / processed / voided / expired; their meaning lives only in BR-INV-24.
-- Compatibility: one new column and one CHECK swapped under the same name; 0055 is not changed.
--   eligibility_days integer NOT NULL, named CHECK eligibility_days >= 1 (the upper bound is the
--     config range of growth.invite_reward.eligibility_days, not stored here). Written by growth
--     (B1-35) at qualification together with amount_fen, from the config value of that moment;
--     later config changes only affect rows qualified afterwards. DEFAULT 30 (the BR-INV-24
--     default) exists only while the column is added, to fill any existing row; it is dropped in
--     the same migration so a writer that omits the column fails with a not-null violation
--     instead of being silently given 30.
--   invite_rewards_status_check: dropped and added back under the same name with expired in
--     place of budget_exhausted, NOT VALID; the next migration (0058) only validates it. Existing
--     rows are not rewritten: the campaign is off by default and no budget_exhausted row exists;
--     if one did, the validation would fail and expose it.
-- Grants: unchanged. The table-level INSERT of couli_app (0055) covers the new column; its
-- column-level write list does not include eligibility_days, so the locked value cannot be
-- changed by the application. couli_readonly keeps SELECT.
-- Guard: invite_rewards is a funds table; the status CHECK is rebuilt under the same name with a
-- different definition, so this file is registered by hash in APPROVED_GUARD_CHANGES of
-- tools/ci/lint-migrations.ts (task F1-02zy). Any later edit of this file needs a new
-- registration.
-- Recovery: restore from backup; no down migration.
--
-- Timeouts: ADD COLUMN with a constant default, DROP DEFAULT and DROP / ADD CONSTRAINT take an
-- ACCESS EXCLUSIVE lock on invite_rewards; the NOT NULL default fill and the CHECK on the new
-- column scan a table that holds no real rows before launch. 5s lock wait so a blocked deploy
-- fails fast, 60s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.invite_rewards
  ADD COLUMN eligibility_days integer NOT NULL DEFAULT 30
    CONSTRAINT invite_rewards_eligibility_days_check CHECK (eligibility_days >= 1);

ALTER TABLE app.invite_rewards ALTER COLUMN eligibility_days DROP DEFAULT;

ALTER TABLE app.invite_rewards DROP CONSTRAINT invite_rewards_status_check;

ALTER TABLE app.invite_rewards ADD CONSTRAINT invite_rewards_status_check
  CHECK (status IN ('qualified', 'deferred', 'processed', 'voided', 'expired')) NOT VALID;
