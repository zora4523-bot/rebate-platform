-- Up Migration
-- Suppressed push deliveries in app.notify_logs (08 BR-WATCH-15: when the user has turned a push
-- category off, the push channel is logged as suppressed(push_disabled) while the inbox message is
-- still written; 规划/04 §3.2 notify_logs lists only queued / success / failed, the suppressed value
-- is an orchestrator technical decision pending write-back to the plan). Task B1-12n (orchestrator
-- rulings B1–B6 in the task brief).
-- Compatibility: additive. One new nullable column suppress_reason (existing rows read NULL), the
-- status domain is widened from queued / success / failed to also accept suppressed, and two new
-- CHECKs tie suppressed to its reason and to an empty sent_at. Existing rows, columns, the unique
-- key (app_id, dedupe_key), indexes and grants are unchanged; no data is written. Every existing row
-- has status in queued / success / failed and a NULL suppress_reason, so the new CHECKs hold for
-- all of them. notify_templates, inbox_messages and notification_settings are untouched.
-- Recovery: restore from backup; no down migration. (Narrowing back would be a new migration that,
-- after the application stops writing suppressed rows and those rows are dealt with, drops the two
-- new CHECKs, restores the three-value status CHECK and drops suppress_reason.)
--
-- Shape after this migration:
--   status           queued (default) / success / failed / suppressed.
--   suppress_reason  NULL, or exactly 'push_disabled' (notify_logs_suppress_reason_check).
--   status = 'suppressed' if and only if suppress_reason is not NULL, and a suppressed row has
--   sent_at NULL (notify_logs_suppressed_check). notify_logs_sent_at_check from 0042 stays as is:
--   success requires sent_at, queued forbids it, failed allows either.
--
-- Grants: couli_app already holds table-level SELECT / INSERT / UPDATE on app.notify_logs and
-- couli_readonly SELECT (0042); table-level privileges cover the new column, so no GRANT here.
--
-- Timeouts: ADD COLUMN (nullable, no default) is a catalog-only change; DROP / ADD CONSTRAINT take
-- ACCESS EXCLUSIVE on app.notify_logs, held to commit (the runner uses one transaction), and the
-- validated ADD CONSTRAINTs scan the table once each. 5s lock wait so a blocked deploy fails fast
-- instead of queueing notification traffic behind it; 30s overall as a ceiling for the scans.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.notify_logs ADD COLUMN suppress_reason text;

ALTER TABLE app.notify_logs DROP CONSTRAINT notify_logs_status_check;

-- app.notify_logs is not a funds or attribution table. The runner applies migrations in one
-- transaction, so NOT VALID + VALIDATE would still scan under the ACCESS EXCLUSIVE lock taken by
-- ADD and gain nothing; as in 0044 / 0049, plain validated ADDs are used and the constraints end
-- up validated either way.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_logs ADD CONSTRAINT notify_logs_status_check
  CHECK (status IN ('queued', 'success', 'failed', 'suppressed'));

-- Same reason as above: one transaction, validated ADD.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_logs ADD CONSTRAINT notify_logs_suppress_reason_check
  CHECK (suppress_reason IS NULL OR suppress_reason = 'push_disabled');

-- Same reason as above: one transaction, validated ADD. status is NOT NULL, so the equality
-- below is never NULL.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.notify_logs ADD CONSTRAINT notify_logs_suppressed_check CHECK (
  (status = 'suppressed') = (suppress_reason IS NOT NULL)
  AND (status <> 'suppressed' OR sent_at IS NULL)
);
