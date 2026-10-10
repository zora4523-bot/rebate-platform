-- Up Migration
-- Platform icon replacements (08 BR-TEXT-24: 安装包与 H5 产物内置一套作兜底，后台可按平台上传
-- 替换图并发布、回滚; 规划/04 §10.1 platform_icons → {url, sha256, version}; contracts/openapi.yaml
-- AdminPlatformIcon, AdminPlatformIconVersion, AdminPlatformIconUpload; contracts/enums/platform.yaml
-- platform_icon_key; 04 §3.2 names no table, so names follow the orchestrator ruling in
-- couli-runs/F1-06n/decision-orchestrator.md rulings 1 and 2; SPEC_REF b3924b1; ADR-0001 §4).
-- Task F1-06n.
-- Compatibility: additive. Three new tables in schema app; no existing object changes. Recovery:
-- restore from backup; no down migration.
--
-- platform_icon_uploads: staging rows for an uploaded file before it becomes a version. id is a
-- UUIDv7 supplied by the application. expires_at comes from the injected Clock (created_at + 24
-- hours, written by the admin module), so it has no SQL default; SQL only enforces that it is
-- strictly later than created_at. Uploads are never updated or deleted by the app; expired rows
-- are simply ignored.
-- platform_icon_versions: one row per (app_id, key, version), each version built from exactly one
-- upload (upload_id is globally unique). Media columns (sha256, format, bytes, sanitized) are
-- immutable. source_url and downloaded_on are the registration that publishing requires (08
-- BR-TEXT-24 细则: 缺任一项只能存草稿); the publish rule itself belongs to the admin module, so
-- both stay nullable. revision starts at 1 and grows with every registration edit;
-- ever_published flips to true on first publication. created_by / updated_by are login-name
-- snapshots for display; the *_admin_id columns carry the reference.
-- platform_icons: one row per icon key, created on demand. current_version NULL means the
-- built-in icon is served (恢复内置 removes the key from the delivered map). revision starts at
-- 0 and grows with every publish, rollback and restore. The composite foreign key to
-- platform_icon_versions keeps current_version inside the same app and key; MATCH SIMPLE skips
-- it while current_version is NULL. The key CHECK enforces only the syntax; the current key
-- whitelist (contracts platform_icon_key) is checked by the application so new platforms need
-- no migration.
-- Foreign keys do not cascade (db/AGENTS.md rule 7). No trigger is added (rule 8).
--
-- Grants: couli_app gets SELECT and INSERT on all three tables, UPDATE on platform_icons, and
-- column-level UPDATE on platform_icon_versions (source_url, downloaded_on, revision,
-- ever_published) only; no DELETE anywhere. couli_readonly gets SELECT on all three tables. No
-- other role (couli_payout, couli_maint) gets any privilege.
--
-- Timeouts: only new, empty tables are created; the sole lock taken on an existing table is the
-- SHARE ROW EXCLUSIVE lock on app.admin_users for the new foreign keys, which is brief. 5s lock
-- wait so a blocked deploy fails fast instead of queueing admin traffic behind it; 30s overall
-- as a ceiling for catalog changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.platform_icon_uploads (
  id uuid NOT NULL,
  app_id text NOT NULL,
  key text NOT NULL,
  sha256 text NOT NULL,
  format text NOT NULL,
  bytes integer NOT NULL,
  sanitized boolean NOT NULL,
  created_by_admin_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT platform_icon_uploads_pkey PRIMARY KEY (id),
  CONSTRAINT platform_icon_uploads_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_icon_uploads_format_check CHECK (format IN ('svg', 'png')),
  CONSTRAINT platform_icon_uploads_bytes_check CHECK (bytes > 0),
  CONSTRAINT platform_icon_uploads_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT platform_icon_uploads_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id)
    REFERENCES app.admin_users (id)
);

CREATE TABLE app.platform_icon_versions (
  app_id text NOT NULL,
  key text NOT NULL,
  version integer NOT NULL,
  upload_id uuid NOT NULL,
  sha256 text NOT NULL,
  format text NOT NULL,
  bytes integer NOT NULL,
  sanitized boolean NOT NULL,
  source_url text,
  downloaded_on date,
  ever_published boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  created_by_admin_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_icon_versions_pkey PRIMARY KEY (app_id, key, version),
  CONSTRAINT platform_icon_versions_upload_id_key UNIQUE (upload_id),
  CONSTRAINT platform_icon_versions_version_check CHECK (version >= 1),
  CONSTRAINT platform_icon_versions_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT platform_icon_versions_format_check CHECK (format IN ('svg', 'png')),
  CONSTRAINT platform_icon_versions_bytes_check CHECK (bytes > 0),
  CONSTRAINT platform_icon_versions_revision_check CHECK (revision >= 1),
  CONSTRAINT platform_icon_versions_upload_id_fkey FOREIGN KEY (upload_id)
    REFERENCES app.platform_icon_uploads (id),
  CONSTRAINT platform_icon_versions_created_by_admin_id_fkey FOREIGN KEY (created_by_admin_id)
    REFERENCES app.admin_users (id)
);

CREATE TABLE app.platform_icons (
  app_id text NOT NULL,
  key text NOT NULL,
  current_version integer,
  revision integer NOT NULL DEFAULT 0,
  updated_by text,
  updated_by_admin_id uuid,
  updated_at timestamptz,
  CONSTRAINT platform_icons_pkey PRIMARY KEY (app_id, key),
  CONSTRAINT platform_icons_key_check CHECK (key ~ '^[a-z_]{1,32}$'),
  CONSTRAINT platform_icons_revision_check CHECK (revision >= 0),
  CONSTRAINT platform_icons_current_version_fkey FOREIGN KEY (app_id, key, current_version)
    REFERENCES app.platform_icon_versions (app_id, key, version) MATCH SIMPLE,
  CONSTRAINT platform_icons_updated_by_admin_id_fkey FOREIGN KEY (updated_by_admin_id)
    REFERENCES app.admin_users (id)
);

GRANT SELECT, INSERT, UPDATE ON app.platform_icons TO couli_app;
GRANT SELECT, INSERT ON app.platform_icon_versions TO couli_app;
GRANT UPDATE (source_url, downloaded_on, revision, ever_published)
  ON app.platform_icon_versions TO couli_app;
GRANT SELECT, INSERT ON app.platform_icon_uploads TO couli_app;

GRANT SELECT ON app.platform_icons, app.platform_icon_versions, app.platform_icon_uploads
  TO couli_readonly;
