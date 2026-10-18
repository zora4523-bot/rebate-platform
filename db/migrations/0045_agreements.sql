-- Up Migration
-- Agreement versions (规划/04 §3.2 agreements: type privacy / agreement / labor_agreement,
-- version, min_version, requires_resign (劳务协议改版需重签, BR-WDR-31), legal_confirmed_by,
-- legal_confirm_note (OPS-14), url, published_at; 写者 content; 协议版本对应配置 legal.*
-- (BR-ID-12)). Names and checks follow the orchestrator ruling in the F1-02k brief §9.2
-- (defaults L1-L4; SPEC_REF 99cc36f; ADR-0001 §4). Task F1-02k.
-- Compatibility: additive. One new ordinary table in schema app; no existing object changes.
-- Recovery: restore from backup; no down migration.
--
-- agreements: one row per published agreement version, insert-only (L2: no draft, no status,
-- no state machine; the body lives in the referenced article revision, not here).
--   id: UUIDv7 from the application, primary key, no default.
--   type: privacy / agreement / labor_agreement. version >= 1; 1 <= min_version <= version.
--     (app_id, type, version) is unique; the current version of a type is its largest version.
--   requires_resign (L3): always false for privacy and agreement; for labor_agreement it equals
--     (min_version = version), i.e. a labor version that raises the minimum to itself requires
--     resigning, so labor v1 always requires it.
--   article_id + article_version (L1): the exact article revision holding the text, referencing
--     app.articles (id, version); articles carry no app_id in their key, so the same-app match
--     is the service's job. text_sha256: 64 lowercase hex digest of the published text.
--   url: the published https:// address.
--   legal_confirmed_by / legal_confirm_note (L4): required on every publication, nonblank after
--     trimming; the confirmation date goes to the request and the audit log, not this table.
--   published_at: the injected Clock time, no database default; published_by: the admin
--     account, referencing app.admin_users (id). created_at: technical insert time.
-- Foreign keys do not cascade (db/AGENTS.md rule 7). No trigger is added (rule 8; the rule
-- tests require none): immutability rests on the grants below. No secondary index: the unique
-- key serves the current-version lookup.
--
-- Grants: couli_app (writer: content) SELECT and INSERT only; no UPDATE, DELETE or TRUNCATE for
-- any role. couli_readonly SELECT. couli_payout, couli_maint and PUBLIC get nothing.
--
-- Timeouts: only a new, empty table is created; the only locks on existing tables are the brief
-- SHARE ROW EXCLUSIVE locks on app.articles and app.admin_users for the new foreign keys. 5s
-- lock wait so a blocked deploy fails fast instead of queueing admin traffic behind it; 30s
-- overall as a ceiling for catalog changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.agreements (
  id uuid NOT NULL,
  app_id text NOT NULL,
  type text NOT NULL,
  version integer NOT NULL,
  min_version integer NOT NULL,
  requires_resign boolean NOT NULL,
  article_id uuid NOT NULL,
  article_version integer NOT NULL,
  text_sha256 text NOT NULL,
  url text NOT NULL,
  legal_confirmed_by text NOT NULL,
  legal_confirm_note text NOT NULL,
  published_at timestamptz NOT NULL,
  published_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agreements_pkey PRIMARY KEY (id),
  CONSTRAINT agreements_app_type_version_key UNIQUE (app_id, type, version),
  CONSTRAINT agreements_type_check CHECK (type IN ('privacy', 'agreement', 'labor_agreement')),
  CONSTRAINT agreements_version_check CHECK (version >= 1),
  CONSTRAINT agreements_min_version_check CHECK (min_version >= 1 AND min_version <= version),
  CONSTRAINT agreements_requires_resign_check CHECK (
    CASE
      WHEN type = 'labor_agreement' THEN requires_resign = (min_version = version)
      ELSE requires_resign = false
    END
  ),
  CONSTRAINT agreements_text_sha256_check CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agreements_url_check CHECK (url ~ '^https://'),
  CONSTRAINT agreements_legal_confirm_check CHECK (
    btrim(legal_confirmed_by) <> '' AND btrim(legal_confirm_note) <> ''
  ),
  CONSTRAINT agreements_article_fkey FOREIGN KEY (article_id, article_version)
    REFERENCES app.articles (id, version),
  CONSTRAINT agreements_published_by_fkey FOREIGN KEY (published_by)
    REFERENCES app.admin_users (id)
);

GRANT SELECT, INSERT ON app.agreements TO couli_app;
GRANT SELECT ON app.agreements TO couli_readonly;
