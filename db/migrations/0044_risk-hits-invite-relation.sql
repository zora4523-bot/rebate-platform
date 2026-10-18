-- Up Migration
-- risk_hits records invite-relation hits (BR-INV-08 30403 refusals, BR-INV-09 same-device
-- unbinding at first App login). Task B1-03x (orchestrator rulings E23, E32).
-- Compatibility: widening only. risk_hits_ref_type_check gains the value invite_relation (ref_id =
-- the invitee's user_id as text); the three existing values stay valid, existing rows are not
-- touched. risk_judgements.ref_type and the risk_action CHECKs of risk_rules / risk_hits are not
-- changed (the four invite rules record risk_action block; BR-INV-09's unbinding is told apart by
-- rule_id inv_09_same_device). No new column, so no grant changes (0014's column INSERT grant on
-- risk_hits for couli_app already covers every column the writer sets).
-- Recovery: restore from backup; no down migration. (Narrowing back would first need every
-- invite_relation row removed.)
--
-- Timeouts: DROP / ADD CONSTRAINT take an ACCESS EXCLUSIVE lock on risk_hits; 5s lock wait so a
-- blocked deploy fails fast instead of queueing risk writes behind it, 60s overall as a ceiling
-- for the CHECK scan of a small table.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.risk_hits DROP CONSTRAINT risk_hits_ref_type_check;

-- The new CHECK is strictly wider than the one it replaces (same values plus invite_relation), so
-- every existing row satisfies it; the table holds no real rows before launch and the scan runs
-- inside the ACCESS EXCLUSIVE lock taken just above, so NOT VALID + VALIDATE would gain nothing.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.risk_hits ADD CONSTRAINT risk_hits_ref_type_check
  CHECK (ref_type IN ('order', 'withdrawal', 'blocked_request', 'invite_relation'));
