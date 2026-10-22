-- Up Migration
-- One pending scheduled-publish slot on app.pages (规划/01 F-HOME-07 发布（立即/定时）→ 灰度
-- 1%/10%/100%; 规划/04 §3.2 pages / page_versions; orchestrator rulings D8 / Y1 / Y5 in the
-- F1-09n task brief §9.2). Task F1-09n.
-- Compatibility: additive. Four new nullable columns without defaults, so every existing row and
-- every INSERT that omits them stores NULL; nothing is backfilled. page_versions and the existing
-- columns, constraints and grants of 0039 are unchanged.
-- Recovery: restore from backup; no down migration.
--
-- The slot is all-or-nothing: either all four columns are NULL (nothing scheduled) or all four are
-- set. scheduled_by_admin_id is part of the slot (Y1) because the scheduled publish later writes
-- page_versions.publisher and pages.updated_by_admin_id, and publisher must be set together with
-- publish_at. scheduled_gray_percent is 1..100 (Y5): 100 means full traffic, matching the request
-- body's gray_percent, unlike the stored gray_percent column (0..100). Whether the scheduled
-- version differs from current_version / gray_version is left to the service layer.
-- The composite foreign key keeps the scheduled version inside the same app and page (MATCH
-- SIMPLE skips it while the slot is empty); neither foreign key cascades (db/AGENTS.md rule 7).
-- No secondary index: the scheduled-publish job finds rows by the primary key.
--
-- Validation without NOT VALID: the columns are new and NULL on every existing row, so the CHECK
-- and foreign-key scans pass trivially; the runner uses one transaction, so NOT VALID + VALIDATE
-- would scan under the same lock and gain nothing (as in 0050). pages is not a funds or
-- attribution table.
--
-- Grants follow 0039's column-level model: couli_app keeps table-wide SELECT / INSERT (which cover
-- the new columns) and gets UPDATE on the four slot columns only; couli_readonly keeps table-wide
-- SELECT. No other role gets anything.
--
-- Timeouts: ALTER TABLE takes an ACCESS EXCLUSIVE lock on app.pages (a small table) and SHARE ROW
-- EXCLUSIVE locks on app.page_versions and app.admin_users for the foreign keys, held to commit;
-- 5s lock wait so a blocked deploy fails fast instead of queueing page reads behind it, 30s overall
-- as a ceiling for the constraint scans of small tables and the catalog changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.pages
  ADD COLUMN scheduled_version integer,
  ADD COLUMN scheduled_gray_percent smallint,
  ADD COLUMN scheduled_at timestamptz,
  ADD COLUMN scheduled_by_admin_id uuid;

-- New columns, NULL on every existing row: validating immediately is instant.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.pages ADD CONSTRAINT pages_scheduled_check CHECK (
  (
    scheduled_version IS NULL
    AND scheduled_gray_percent IS NULL
    AND scheduled_at IS NULL
    AND scheduled_by_admin_id IS NULL
  )
  OR (
    scheduled_version IS NOT NULL
    AND scheduled_gray_percent IS NOT NULL
    AND scheduled_at IS NOT NULL
    AND scheduled_by_admin_id IS NOT NULL
    AND scheduled_gray_percent BETWEEN 1 AND 100
  )
);

-- New column, NULL on every existing row (MATCH SIMPLE skips them): validating is instant.
-- squawk-ignore constraint-missing-not-valid, adding-foreign-key-constraint
ALTER TABLE app.pages ADD CONSTRAINT pages_scheduled_version_fkey
  FOREIGN KEY (app_id, page_key, scheduled_version)
  REFERENCES app.page_versions (app_id, page_key, version) MATCH SIMPLE;

-- New column, NULL on every existing row: validating is instant.
-- squawk-ignore constraint-missing-not-valid, adding-foreign-key-constraint
ALTER TABLE app.pages ADD CONSTRAINT pages_scheduled_by_admin_id_fkey
  FOREIGN KEY (scheduled_by_admin_id) REFERENCES app.admin_users (id);

GRANT UPDATE (scheduled_version, scheduled_gray_percent, scheduled_at, scheduled_by_admin_id)
  ON app.pages TO couli_app;
