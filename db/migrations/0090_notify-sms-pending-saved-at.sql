-- Up Migration
-- When the SMS registration awaiting its test send was saved, on app.notify_templates (08 BR-TEXT-20
-- 细则「短信渠道登记与后台渠道开关」, the pending registration; contract CT-24t, whose
-- pending.saved_at keeps its shape). Task B1-12zb (orchestrator ruling D10-355 ①, task supplement B).
-- Compatibility: additive. One new nullable column without a default on notify_templates
-- (sms_pending_saved_at); existing rows read NULL in it. Nothing is backfilled: a pending row
-- saved before this migration has only the six pending columns of 0086, and the application
-- falls back to sms_tested_at for it, freezing that value into the new column on its first
-- retest. The column is deliberately not part of notify_templates_sms_pending_check (the
-- all-or-none CHECK of the six pending columns stays as it is), so six-column pending rows remain
-- writable. Existing columns, CHECKs, primary keys, the unique key (app_id, dedupe_key), indexes
-- and grants are unchanged.
-- Recovery: restore from backup; no down migration. (Narrowing back would be a new migration that,
-- after the application stops reading and writing the column, drops it.)
--
-- Shape after this migration:
--   notify_templates:
--     sms_pending_saved_at  when the pending registration was saved (the save that test-sends it,
--                           whatever the test outcome); NULL when nothing is pending, or on a
--                           pending row saved before this migration and not retested since.
--                           A retest leaves it unchanged; enabling or discarding the pending
--                           registration clears it together with the six pending columns.
--
-- Grants: couli_app already holds table-level SELECT / INSERT / UPDATE on notify_templates and
-- couli_readonly SELECT (0042); table-level privileges cover the new column, so no GRANT here.
--
-- Timeouts: ADD COLUMN (nullable, no default) is a catalog-only change but takes ACCESS EXCLUSIVE
-- on the table briefly. 5s lock wait so a blocked deploy fails fast instead of queueing
-- notification traffic behind it; 30s overall as a ceiling (no scan or rewrite is expected).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.notify_templates ADD COLUMN sms_pending_saved_at timestamptz;
