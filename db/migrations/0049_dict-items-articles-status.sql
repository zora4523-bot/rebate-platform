-- Up Migration
-- Dictionary versions and the article status domain (规划/04 §3.2 dict_items: dict, code, text,
-- version, 写者 content, 字典见 BR-TEXT-12; 04 dict_version; 08 BR-TEXT-12 发布时 dict_version +1;
-- 04 articles: 已发布 = status 精确等于 published). Names, checks and grants follow the
-- orchestrator ruling in the F1-02q brief §9.2 (defaults L13 / L14 / L15 / L19; SPEC_REF 99cc36f;
-- ADR-0001 §4). Task F1-02q.
-- Compatibility: dict_items is additive (one new ordinary table in schema app). app.articles gains
-- articles_status_check (status IN draft / published / offline, case-sensitive, no other value)
-- and couli_app's table-wide UPDATE on app.articles is narrowed to five columns; SELECT and
-- INSERT are unchanged, couli_readonly is unchanged. No data is written or changed here. Before
-- deploying, every environment must hold only those three status values
-- (SELECT status, count(*) FROM app.articles GROUP BY 1), otherwise ADD CONSTRAINT fails and the whole
-- migration rolls back.
-- Recovery: restore from backup; no down migration. (Widening back would be a new migration that
-- drops articles_status_check and grants UPDATE on app.articles again.)
--
-- dict_items: one row per saved dictionary entry version, insert-only (L14: every save is a new
-- version; the effective text of an entry is its row with the largest version <= dict_version).
--   dict: the first segment of the text key, lowercase snake (L13). code: the rest of the key,
--     no format check (keys without a dot, such as ai_label, give code '').
--   version >= 1 (dict_version counts from "1"; "0" means nothing published, L14).
--   text NULL means fall back to the packaged default text.
--   created_by: the admin account, referencing app.admin_users (id). created_at: technical
--     insert time.
--   dict_items_pkey (app_id, dict, code, version) also serves the "largest version <= dict_version"
--   lookup, so no secondary index. The foreign key does not cascade (db/AGENTS.md rule 7). No
--   trigger is added (rule 8): immutability rests on the grants below.
--
-- Grants: dict_items — couli_app (writer: content) SELECT and INSERT only; no UPDATE, DELETE or
-- TRUNCATE for any role; couli_readonly SELECT; couli_payout, couli_maint and PUBLIC nothing.
-- app.articles — couli_app keeps SELECT and INSERT, and UPDATE only on status, published_at,
-- notice_end_at, row_version and updated_at (L19: revisions are new rows; title, body, category,
-- notice settings, version, app_id, id and created_at are never rewritten in place).
--
-- Timeouts: ADD CONSTRAINT and REVOKE / GRANT take locks on app.articles (ADD takes
-- ACCESS EXCLUSIVE, held to commit since the runner uses one transaction) and the new foreign key
-- a SHARE ROW EXCLUSIVE lock on app.admin_users. 5s lock wait so a blocked deploy fails fast
-- instead of queueing admin and article traffic behind it; 30s overall as a ceiling for the
-- CHECK scan of a small table and catalog changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.dict_items (
  app_id text NOT NULL,
  dict text NOT NULL,
  code text NOT NULL,
  version integer NOT NULL,
  text text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dict_items_pkey PRIMARY KEY (app_id, dict, code, version),
  CONSTRAINT dict_items_version_check CHECK (version >= 1),
  CONSTRAINT dict_items_dict_check CHECK (dict ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT dict_items_created_by_fkey FOREIGN KEY (created_by)
    REFERENCES app.admin_users (id)
);

GRANT SELECT, INSERT ON app.dict_items TO couli_app;
GRANT SELECT ON app.dict_items TO couli_readonly;

-- app.articles is not a funds or attribution table. The runner applies migrations in one
-- transaction, so NOT VALID + VALIDATE would still scan under the ACCESS EXCLUSIVE lock taken by
-- ADD and gain nothing (squawk flags that pattern too); the table is small (content revisions),
-- so a plain validated ADD is used, as in 0044. The constraint ends up validated either way.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.articles ADD CONSTRAINT articles_status_check
  CHECK (status IN ('draft', 'published', 'offline'));

REVOKE UPDATE ON app.articles FROM couli_app;
GRANT UPDATE (status, published_at, notice_end_at, row_version, updated_at)
  ON app.articles TO couli_app;
