-- Up Migration
-- Back-office display name on app.admin_users (规划/04 §3.2 row admin_users: display_name, 后台显示名,
-- text 可空、≤ 32 字, shown as the handler in lists, audit and recovery review; 2026-10-19 补).
-- Task F1-06zi (orchestrator ruling in the task brief §9).
-- Compatibility: additive. One new nullable column without a default, so every existing row and
-- every INSERT that omits it stores NULL; nothing is backfilled. A non-NULL value must be 1–32
-- characters (char_length counts characters, not bytes, so Chinese and supplementary characters
-- count as one each); the empty string is rejected, "no name" is NULL. Existing columns,
-- constraints and grants of 0016 are unchanged.
-- Recovery: restore from backup; no down migration. (Removing it would be a later contract step
-- that drops the column once no reader uses it.)
--
-- Grants follow 0016's column-level model: couli_app keeps table-wide SELECT / INSERT (which cover
-- the new column) and gets UPDATE on display_name only; couli_readonly gets SELECT on display_name
-- only. No other role gets anything.
--
-- Validation without NOT VALID: the column is new and NULL on every existing row, so the CHECK
-- scan passes trivially; the runner uses one transaction, so NOT VALID + VALIDATE would scan under
-- the same ACCESS EXCLUSIVE lock and gain nothing (as in 0047 / 0049). admin_users is not a funds
-- or attribution table.
--
-- Timeouts: ALTER TABLE takes an ACCESS EXCLUSIVE lock on admin_users (held to commit); 5s lock
-- wait so a blocked deploy fails fast instead of queueing admin logins behind it, 30s overall as a
-- ceiling for the CHECK scan of a small table and the catalog changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.admin_users ADD COLUMN display_name text;

-- New column, NULL on every existing row: validating immediately is instant.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.admin_users ADD CONSTRAINT admin_users_display_name_len_check
  CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 32);

GRANT UPDATE (display_name) ON TABLE app.admin_users TO couli_app;
GRANT SELECT (display_name) ON TABLE app.admin_users TO couli_readonly;
