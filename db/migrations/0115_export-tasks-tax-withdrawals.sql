-- Up Migration
-- Opens app.export_tasks to the quarterly tax export (规划/08 BR-WDR-21; contract CT-24zi enum
-- export_resource; task B2-08e, 编排裁定 D10-544): the resource CHECK also takes tax_withdrawals.
-- Compatibility: widening only. Every row the old CHECK accepted is accepted by the new one; no
-- column, default or index changes. Writer: admin (couli_app), as before.
-- export_tasks_audit_masked_check stays: it only speaks of audit_logs, and a tax task may be
-- masked or not (the full version is tax.export_full, totp and a reason).
-- The new CHECK is added NOT VALID (new rows and updates are checked at once) and validated by the
-- next migration (precedent 0113 / 0114): squawk's constraint-missing-not-valid applies, and the
-- two statements below are one replacement of the same name.
-- Grants: unchanged.
-- Recovery: restore from backup; no down migration. (Undoing it is a later migration that narrows
-- the CHECK again, once no tax_withdrawals row remains.)
--
-- Timeouts: DROP CONSTRAINT and ADD CONSTRAINT … NOT VALID are catalog-only but take ACCESS
-- EXCLUSIVE on app.export_tasks, held to commit (the runner uses one transaction); 5s lock wait so
-- a blocked deploy fails fast instead of queueing requests behind it, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.export_tasks DROP CONSTRAINT export_tasks_resource_check;

ALTER TABLE app.export_tasks ADD CONSTRAINT export_tasks_resource_check
  CHECK (resource IN ('users', 'audit_logs', 'tax_withdrawals')) NOT VALID;
