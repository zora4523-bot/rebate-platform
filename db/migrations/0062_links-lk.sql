-- Up Migration
-- Link short code lk on app.links (规划/04 §3.2 links: lk, link 短码, 可空, 唯一 (app_id, lk);
-- 08 BR-ATTR-15 lk 细则). Task B1-08s (orchestrator scope 口径 1, ruling D10-86).
-- Compatibility: additive. One new nullable text column without a default, so every existing row
-- and every INSERT that omits it stores NULL; nothing is backfilled (存量 link 不补发 lk). A
-- non-NULL value must be 1–16 characters of lowercase base36 [0-9a-z] (issued as 6; the parser
-- accepts 1–16 so the length can grow, BR-ATTR-06). Unique (app_id, lk) across platforms; NULLs
-- never conflict. Existing columns, constraints, triggers and their functions of 0006 are
-- unchanged ("lk 写后不可改" is kept by the application, which writes lk on INSERT only).
-- Recovery: restore from backup; no down migration.
--
-- Grants: the table-wide grants of 0006 (couli_app SELECT, INSERT, UPDATE; couli_readonly SELECT)
-- already cover the new column; no column-level grant is added (不另授列级权限).
--
-- Validation without NOT VALID: the column is new and NULL on every existing row, so the inline
-- CHECK passes trivially; the runner uses one transaction, so NOT VALID + VALIDATE would gain
-- nothing (as 0047 / 0049). links is an attribution table, so no squawk-ignore is used: the
-- CHECK is a named column constraint of ADD COLUMN, and the unique key is built as a unique index
-- and then attached with UNIQUE USING INDEX under the same name (as 0046).
--
-- Timeouts: ADD COLUMN takes an ACCESS EXCLUSIVE lock on links (held to commit) and the unique
-- index build a SHARE lock (blocks link inserts while it builds; every existing lk is NULL). 5s
-- lock wait so a blocked deploy fails fast instead of queueing card registrations behind it, 60s
-- overall as a ceiling for the index build.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.links
  ADD COLUMN lk text CONSTRAINT links_lk_check CHECK (lk ~ '^[0-9a-z]{1,16}$');

CREATE UNIQUE INDEX links_app_id_lk_key ON app.links (app_id, lk);

ALTER TABLE app.links
  ADD CONSTRAINT links_app_id_lk_key UNIQUE USING INDEX links_app_id_lk_key;
