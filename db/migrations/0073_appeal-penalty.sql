-- Up Migration
-- Appeals counted per penalty (规划/08 BR-ID-36 细则, D10-147; 04 §3.2 suggests penalty_started_at).
-- Task B1-03v (task brief §9.2). Storage only: the risk state service writes the instant and the
-- appeals service copies it and counts by it.
-- Compatibility: additive; two nullable columns without default (catalog-only, no rewrite), one new
-- CHECK and one column-level grant. Nothing is dropped, renamed or retyped.
--   user_risk_state.penalty_started_at  timestamptz NULL. When the account's current penalty began:
--     set by setRiskState (the single writer) to the change instant when the state goes from normal
--     (or no row) to frozen / banned, or from frozen to banned (a new penalty, D10-147); kept when
--     entering appealing, when an upheld appeal puts the state back and when a freeze is extended;
--     cleared on the way back to normal. Existing rows stay NULL (penalty unknown): the appeals
--     service then falls back to the CT-26e approximation.
--   appeals.penalty_started_at  timestamptz NULL. Copied from user_risk_state at the insert of an
--     account appeal and never updated; NULL for existing rows and for every other target.
--   appeals_penalty_started_at_check  only an account appeal may carry a penalty instant. Added NOT
--     VALID (new rows and updates are checked at once): a VALIDATE in the same transaction is
--     refused by squawk (constraint-missing-not-valid) and appeals, a funds / attribution table
--     (tools/ci/lint-migrations.ts), takes no squawk exception; the next migration validates it
--     (precedent 0057 / 0058, 0071 / 0072). The column is new and NULL everywhere, so no row can
--     violate it.
-- Grants: couli_app gets UPDATE on user_risk_state.penalty_started_at (the table's UPDATE grants are
-- column-level, 0014). The table-level grants already cover the rest: couli_app SELECT / INSERT and
-- couli_readonly SELECT on both tables. appeals.penalty_started_at gets no UPDATE (written once at
-- insert). couli_payout keeps its column-level SELECT on user_risk_state without the new column;
-- couli_maint gets nothing.
-- Recovery: restore from backup; no down migration. (Undoing it would be a later migration that,
-- once nothing reads or writes them, drops the constraint and the two columns.)
--
-- Timeouts: ADD COLUMN without default and ADD CONSTRAINT ... NOT VALID are catalog-only but take
-- ACCESS EXCLUSIVE on app.user_risk_state and app.appeals, held to commit (the runner uses one
-- transaction); 5s lock wait so a blocked deploy fails fast instead of queueing requests behind it,
-- 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.user_risk_state ADD COLUMN penalty_started_at timestamptz;

ALTER TABLE app.appeals ADD COLUMN penalty_started_at timestamptz;

ALTER TABLE app.appeals ADD CONSTRAINT appeals_penalty_started_at_check
  CHECK (penalty_started_at IS NULL OR target_type = 'account') NOT VALID;

GRANT UPDATE (penalty_started_at) ON app.user_risk_state TO couli_app;
