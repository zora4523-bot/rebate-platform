-- Up Migration
-- risk_judgements / risk_hits record same-device judgements made when an invite reward is granted
-- (BR-ID-37: judged once at reward grant; a marked account's reward is not granted, decided by the
-- caller, B1-35). Task B1-35b (orchestrator ruling D10-95 ④).
-- Compatibility: widening only. risk_judgements_ref_type_check and risk_hits_ref_type_check each
-- gain the value invite_reward (ref_id = the invite_rewards row id as text); every existing value
-- stays valid, existing rows are not touched. No other CHECK changes (risk_action of risk_rules /
-- risk_hits, risk_judgements_result_check stay as they are). No new column, so no grant changes
-- (the existing column INSERT grants on both tables for couli_app already cover ref_type).
-- Recovery: restore from backup; no down migration. (Narrowing back would first need every
-- invite_reward row removed from both tables.)
--
-- Timeouts: DROP / ADD CONSTRAINT take an ACCESS EXCLUSIVE lock on each table; 5s lock wait so a
-- blocked deploy fails fast instead of queueing risk writes behind it, 60s overall as a ceiling
-- for the CHECK scans of two small tables.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.risk_judgements DROP CONSTRAINT risk_judgements_ref_type_check;

-- The new CHECK is strictly wider than the one it replaces (same values plus invite_reward), so
-- every existing row satisfies it; the table holds no real rows before launch and the scan runs
-- inside the ACCESS EXCLUSIVE lock taken just above, so NOT VALID + VALIDATE would gain nothing.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.risk_judgements ADD CONSTRAINT risk_judgements_ref_type_check
  CHECK (ref_type IN ('order', 'withdrawal', 'blocked_request', 'invite_reward'));

ALTER TABLE app.risk_hits DROP CONSTRAINT risk_hits_ref_type_check;

-- Same reasoning as above: strictly wider (the four existing values plus invite_reward), no real
-- rows before launch, the scan runs inside the ACCESS EXCLUSIVE lock just taken.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.risk_hits ADD CONSTRAINT risk_hits_ref_type_check
  CHECK (ref_type IN ('order', 'withdrawal', 'blocked_request', 'invite_relation', 'invite_reward'));
