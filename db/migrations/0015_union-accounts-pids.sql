-- Up Migration
-- Union accounts, credentials and promotion positions (规划/04 §3.2 rows union_accounts /
-- union_credentials and union_pids; 02 §6.2–§6.3; BR-ATTR-02, BR-ATTR-28, BR-ATTR-03,
-- BR-ID-24; SPEC_REF 1955639; ADR-0001 §4).
-- Compatibility: additive. Recovery: restore from backup; no down migration.
-- Writer of all three tables: union (规划/02). Entity UUIDs are UUIDv7 supplied by the
-- application; all business moments (sync_start_at, auth_*, last_probe_at, expires_at,
-- hjy_ignore_confirmed_at) come from the injected Clock. Storage only: the probe cron,
-- SMS alerts, step-up, audit, AF-07 and status transitions belong to later tasks.
--
-- union_accounts: one row per station-owner (站长) account of a platform. status is open
-- text (04 gives no vocabulary); 04 names no business-unique key, so none is added and
-- account names may repeat. auth_status (active / expiring / expired) and alert_stage
-- (none / d14 / d7 / d1 / expired; repeated-alert guard, BR-ID-24 ②) each have exactly one
-- single-column CHECK. auth_status has no default: the writer states it on creation.
-- sync_start_at is the creation moment of the app's first pid under the account
-- (BR-ATTR-02), so it is NULL until that pid exists; auth_expires_at mirrors the current
-- credential's expires_at and is NULL before the first authorization. auth_renewed_by is
-- an admin user id without a foreign key: admin_users is created by F1-06a, which also adds
-- that foreign key. last_probe_* stay NULL until the first daily probe (ADD-08).
-- The two composite unique keys only serve as foreign-key targets: credentials reference
-- (app_id, id); pids reference (app_id, platform, id) so a pid's platform always equals its
-- account's platform and no pid can attach to another app's account.
--
-- union_credentials: token history of an account. Tokens are stored only as field-encryption
-- ciphertext, never plaintext: bytea holding the UTF-8 bytes of the platform crypto envelope
-- v1.<key_version>.<payload> (as users.phone_cipher, payout_accounts, devices in 0013; the key
-- version travels inside the envelope, BR-ID-33 practice). refresh_token_cipher is NULL for
-- platforms without a refresh token. expires_at is NULL only when the union returns none.
-- "Current credential" rule: a row with is_current = true; the partial unique index allows at
-- most one per (app_id, union_account_id). Re-authorization inserts the new credential and
-- clears the old marker in the same transaction (clear first, then insert), and also writes
-- union_accounts.auth_expires_at / auth_renewed_at / auth_renewed_by there. couli_app may
-- UPDATE only is_current and updated_at: ciphertexts and expiry of a stored credential never
-- change. couli_readonly may read every column except the two ciphertexts, because processes
-- holding the field keys could otherwise decrypt tokens read through the read-only role; a
-- later migration that adds a column must grant it to couli_readonly explicitly.
--
-- union_pids: the app-attribution allow-list (BR-ATTR-02). Unique (app_id, platform, pid)
-- across accounts, sites, scenes and statuses. status pending / active / retired, default
-- pending; pending, active and retired all count for attribution. pid_scene follows
-- contracts/enums/trade.yaml pid_scene. Before a pid leaves pending, both HJY ignore fields
-- must be filled (BR-ATTR-28) and they cannot be cleared afterwards (multi-column CHECK).
-- site_id: the taobao match key is (platform, union_account_id, site_id, adzone_id); jd and
-- pdd keys have no site, so a taobao row must have site_id and other platforms must not.
-- pid holds the raw platform value (taobao adzone mm_a_b_c, jd positionId, pdd pid, meituan
-- sid prefix). Transition order pending -> active -> retired (no regression), super-role
-- step-up and audit are enforced by the application (B1-19b), not by a trigger.
-- No physical deletion (BR-ATTR-02): no role gets DELETE or TRUNCATE, and an unconditional
-- BEFORE DELETE trigger (db/AGENTS.md #8, the prohibitive kind only) rejects DELETE for every
-- role including the owner. couli_app gets table-level UPDATE (pid included). links.pid gets
-- no foreign key to this table in this migration.
-- No foreign key cascades.

CREATE TABLE app.union_accounts (
  id               uuid NOT NULL,
  app_id           text NOT NULL,
  platform         text NOT NULL,
  account_name     text NOT NULL,
  status           text NOT NULL,
  sync_start_at    timestamptz,
  auth_expires_at  timestamptz,
  auth_status      text NOT NULL,
  auth_renewed_at  timestamptz,
  auth_renewed_by  uuid,
  alert_stage      text NOT NULL DEFAULT 'none',
  last_probe_at    timestamptz,
  last_probe_ok    boolean,
  last_probe_error text,
  row_version      integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT union_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT union_accounts_app_id_id_key UNIQUE (app_id, id),
  CONSTRAINT union_accounts_app_id_platform_id_key UNIQUE (app_id, platform, id),
  CONSTRAINT union_accounts_auth_status_check
    CHECK (auth_status IN ('active', 'expiring', 'expired')),
  CONSTRAINT union_accounts_alert_stage_check
    CHECK (alert_stage IN ('none', 'd14', 'd7', 'd1', 'expired'))
);

CREATE TABLE app.union_credentials (
  id                   uuid NOT NULL,
  app_id               text NOT NULL,
  union_account_id     uuid NOT NULL,
  access_token_cipher  bytea NOT NULL,
  refresh_token_cipher bytea,
  expires_at           timestamptz,
  is_current           boolean NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT union_credentials_pkey PRIMARY KEY (id),
  CONSTRAINT union_credentials_account_fkey FOREIGN KEY (app_id, union_account_id)
    REFERENCES app.union_accounts (app_id, id)
);

CREATE UNIQUE INDEX union_credentials_current_key
  ON app.union_credentials (app_id, union_account_id) WHERE is_current;
CREATE INDEX union_credentials_account_created_idx
  ON app.union_credentials (app_id, union_account_id, created_at);

CREATE TABLE app.union_pids (
  id                       uuid NOT NULL,
  app_id                   text NOT NULL,
  platform                 text NOT NULL,
  union_account_id         uuid NOT NULL,
  site_id                  text,
  pid                      text NOT NULL,
  pid_scene                text NOT NULL,
  status                   text NOT NULL DEFAULT 'pending',
  hjy_ignore_confirmed_at  timestamptz,
  hjy_ignore_evidence_path text,
  row_version              integer NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT union_pids_pkey PRIMARY KEY (id),
  CONSTRAINT union_pids_app_platform_pid_key UNIQUE (app_id, platform, pid),
  CONSTRAINT union_pids_account_fkey FOREIGN KEY (app_id, platform, union_account_id)
    REFERENCES app.union_accounts (app_id, platform, id),
  CONSTRAINT union_pids_status_check CHECK (status IN ('pending', 'active', 'retired')),
  CONSTRAINT union_pids_pid_scene_check
    CHECK (pid_scene IN ('self_buy', 'agent', 'share', 'taolijin', 'fallback', 'query')),
  CONSTRAINT union_pids_hjy_evidence_check CHECK (
    status = 'pending'
    OR (hjy_ignore_confirmed_at IS NOT NULL AND hjy_ignore_evidence_path IS NOT NULL)
  ),
  CONSTRAINT union_pids_site_check CHECK ((platform = 'taobao') = (site_id IS NOT NULL))
);

CREATE INDEX union_pids_account_idx ON app.union_pids (app_id, platform, union_account_id);
CREATE INDEX union_pids_scene_idx ON app.union_pids (app_id, platform, pid_scene, status);

CREATE TRIGGER union_pids_no_delete
  BEFORE DELETE ON app.union_pids
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

GRANT SELECT, INSERT, UPDATE ON app.union_accounts, app.union_pids TO couli_app;
GRANT SELECT, INSERT ON app.union_credentials TO couli_app;
GRANT UPDATE (is_current, updated_at) ON app.union_credentials TO couli_app;
GRANT SELECT ON app.union_accounts, app.union_pids TO couli_readonly;
GRANT SELECT (id, app_id, union_account_id, expires_at, is_current, created_at, updated_at)
  ON app.union_credentials TO couli_readonly;
