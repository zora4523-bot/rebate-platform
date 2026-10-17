-- Up Migration
-- Page configuration tables (规划/04 §3.2 pages / page_versions: page_key / version, sections
-- JSON, status draft / published / rolled_back, gray_percent, render_count, error_count,
-- publish_at, publisher; 灰度按 device_id 哈希分桶，无 device_id 给全量版 (OPS-05); 04 §3.2
-- page_preview_tokens: token_hash, page_key, version, created_by, expire_at (10 分钟),
-- used_count, 写者 content (TECH-11); 04 §6.2 page_key home / custom:*; contracts CT-02l page
-- revision CAS; names and checks follow the orchestrator ruling in
-- couli-runs/F1-09a/decision-orchestrator.md rulings 1-9; SPEC_REF 038229e; ADR-0001 §4).
-- Task F1-09a.
-- Compatibility: additive. Three new tables in schema app; no existing object changes. Recovery:
-- restore from backup; no down migration.
--
-- page_versions: one row per saved draft (app_id, page_key, version). sections is written once
-- and never updated; only status, publish_at, publisher and the render / error counters change.
-- A draft has neither publish_at nor publisher; published and rolled_back rows have both.
-- publisher and created_by_admin_id carry admin account ids (display names are joined from
-- admin_users). render_count / error_count are only created here; automatic rollback is a
-- separate task.
-- pages: one row per page. current_version is the full-traffic version (NULL: nothing
-- published yet); gray_version is the single gray version, which exists only with gray_percent
-- 1..99, only beside a full version, and never equals it (gray_percent 100 is stored as a full
-- version). revision starts at 0 and grows with every write, for compare-and-set. The composite
-- foreign keys keep both pointers inside the same app and page; MATCH SIMPLE skips them while
-- the pointer is NULL. page_versions has no foreign key back to pages, to avoid a cycle.
-- page_preview_tokens: read-only draft previews. Only the sha256 hex of the token is stored.
-- expire_at has no SQL default: the application writes both created_at and expire_at from the
-- injected Clock (note for F1-09e: otherwise a test clock disagrees with now() and the
-- expire_at check rejects the row); SQL only enforces 0 < expire_at - created_at <= 10 minutes.
-- Foreign keys do not cascade (db/AGENTS.md rule 7). No trigger is added (rule 8): immutability
-- of version content and the absence of deletes rest on the grants below. No secondary index:
-- reads and writes go through the primary keys.
--
-- Grants: couli_app (writer: content) gets SELECT and INSERT on all three tables and
-- column-level UPDATE only: pages (current_version, gray_version, gray_percent, revision,
-- updated_by_admin_id, updated_at); page_versions (status, publish_at, publisher,
-- render_count, error_count); page_preview_tokens (used_count). No DELETE or TRUNCATE for any
-- role. couli_readonly gets SELECT on all three tables. couli_payout, couli_maint and PUBLIC get
-- nothing.
--
-- Timeouts: only new, empty tables are created; the sole lock taken on an existing table is the
-- SHARE ROW EXCLUSIVE lock on app.admin_users for the new foreign keys, which is brief. 5s lock
-- wait so a blocked deploy fails fast instead of queueing admin traffic behind it; 30s overall
-- as a ceiling for catalog changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.page_versions (
  app_id text NOT NULL,
  page_key text NOT NULL,
  version integer NOT NULL,
  sections jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  render_count bigint NOT NULL DEFAULT 0,
  error_count bigint NOT NULL DEFAULT 0,
  publish_at timestamptz,
  publisher uuid,
  created_by_admin_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT page_versions_pkey PRIMARY KEY (app_id, page_key, version),
  CONSTRAINT page_versions_page_key_check CHECK (page_key ~ '^(home|custom:[a-z0-9_-]{1,57})$'),
  CONSTRAINT page_versions_version_check CHECK (version >= 1),
  CONSTRAINT page_versions_sections_check CHECK (jsonb_typeof(sections) = 'array'),
  CONSTRAINT page_versions_status_check CHECK (status IN ('draft', 'published', 'rolled_back')),
  CONSTRAINT page_versions_counts_check CHECK (render_count >= 0 AND error_count >= 0),
  CONSTRAINT page_versions_publish_check CHECK (
    (status = 'draft') = (publish_at IS NULL) AND (publish_at IS NULL) = (publisher IS NULL)
  ),
  CONSTRAINT page_versions_publisher_fkey FOREIGN KEY (publisher)
    REFERENCES app.admin_users (id),
  CONSTRAINT page_versions_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id)
    REFERENCES app.admin_users (id)
);

CREATE TABLE app.pages (
  app_id text NOT NULL,
  page_key text NOT NULL,
  current_version integer,
  gray_version integer,
  gray_percent smallint NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 0,
  updated_by_admin_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pages_pkey PRIMARY KEY (app_id, page_key),
  CONSTRAINT pages_page_key_check CHECK (page_key ~ '^(home|custom:[a-z0-9_-]{1,57})$'),
  CONSTRAINT pages_gray_percent_check CHECK (gray_percent BETWEEN 0 AND 100),
  CONSTRAINT pages_gray_check CHECK (
    (gray_version IS NULL AND gray_percent = 0)
    OR (
      gray_version IS NOT NULL
      AND gray_percent BETWEEN 1 AND 99
      AND current_version IS NOT NULL
      AND gray_version <> current_version
    )
  ),
  CONSTRAINT pages_revision_check CHECK (revision >= 0),
  CONSTRAINT pages_current_version_fkey FOREIGN KEY (app_id, page_key, current_version)
    REFERENCES app.page_versions (app_id, page_key, version) MATCH SIMPLE,
  CONSTRAINT pages_gray_version_fkey FOREIGN KEY (app_id, page_key, gray_version)
    REFERENCES app.page_versions (app_id, page_key, version) MATCH SIMPLE,
  CONSTRAINT pages_updated_by_admin_id_fkey FOREIGN KEY (updated_by_admin_id)
    REFERENCES app.admin_users (id)
);

CREATE TABLE app.page_preview_tokens (
  token_hash text NOT NULL,
  app_id text NOT NULL,
  page_key text NOT NULL,
  version integer NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expire_at timestamptz NOT NULL,
  used_count integer NOT NULL DEFAULT 0,
  CONSTRAINT page_preview_tokens_pkey PRIMARY KEY (token_hash),
  CONSTRAINT page_preview_tokens_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT page_preview_tokens_expire_at_check CHECK (
    expire_at > created_at AND expire_at <= created_at + interval '10 minutes'
  ),
  CONSTRAINT page_preview_tokens_used_count_check CHECK (used_count >= 0),
  CONSTRAINT page_preview_tokens_version_fkey FOREIGN KEY (app_id, page_key, version)
    REFERENCES app.page_versions (app_id, page_key, version),
  CONSTRAINT page_preview_tokens_created_by_fkey FOREIGN KEY (created_by)
    REFERENCES app.admin_users (id)
);

GRANT SELECT, INSERT ON app.pages TO couli_app;
GRANT UPDATE (
  current_version, gray_version, gray_percent, revision, updated_by_admin_id, updated_at
) ON app.pages TO couli_app;
GRANT SELECT, INSERT ON app.page_versions TO couli_app;
GRANT UPDATE (status, publish_at, publisher, render_count, error_count)
  ON app.page_versions TO couli_app;
GRANT SELECT, INSERT ON app.page_preview_tokens TO couli_app;
GRANT UPDATE (used_count) ON app.page_preview_tokens TO couli_app;

GRANT SELECT ON app.pages, app.page_versions, app.page_preview_tokens TO couli_readonly;
