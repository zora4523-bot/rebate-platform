-- Up Migration
-- Identity sessions baseline (规划/04 §3.2 rows sessions / refresh_tokens, consent_records,
-- devices; BR-ID-07, BR-ID-09, BR-ID-12, BR-ID-13, BR-WDR-31; SPEC_REF b89ca4e; ADR-0001 §4).
-- Compatibility: additive for the three new tables; NOT additive for devices (see below).
-- Recovery: restore from backup; no down migration. A dropped install_secret_hash cannot be
-- restored by a later migration: affected devices register again to get a new install_secret.
-- Writer of all four tables: identity (规划/02 §4.1).
--
-- devices: install_secret_hash is replaced by install_secret_cipher (规划 #45, 2026-10-05;
-- 04 §3.2 devices row). Request signatures are HMAC-SHA256(install_secret, ...) (BR-ID-09), so
-- the server needs the original value; a hash cannot verify a signature.
-- Deliberate exception to db/AGENTS.md #3 (no expand and contract in one migration): nothing
-- has been released, so there is no production data, and the old hash can never be
-- backfilled into a ciphertext: splitting this over two releases would not yield one usable
-- device. So the migration expands, backfills and contracts in one go, and also upgrades
-- local or staging databases that already have devices rows: it adds the column as NULL-able,
-- revokes every existing row (none can ever pass signature verification again), stores an
-- empty byte string as a placeholder meaning "no usable key", then sets NOT NULL and drops
-- the hash. An empty ciphertext must never be used to verify a signature; readers check
-- revoked_at first. A revoked X-Device-Id gets 10402 and the client registers again once and
-- replays (BR-ID-09), the existing recovery path. The backfill reads no SQL clock
-- (db/AGENTS.md #6; a CLOCK_NOW environment would otherwise get moments outside the business
-- clock): the revocation moment is unknown, so revoked_at takes the row's own last_seen_at
-- (NOT NULL, deterministic); updated_at is left unchanged; row_version is incremented as for
-- any CAS write (0005). devices_install_secret_present_check allows the empty placeholder
-- only on revoked rows: a revocation cannot be cleared while the key is empty, and no active
-- row can be inserted with an empty ciphertext. The column is bytea like the other *_cipher
-- columns (users.phone_cipher, payout_accounts) and stores the UTF-8 bytes of the
-- field-encryption ciphertext string (v1.<key_version>.<payload>, platform crypto module).
-- couli_app keeps its table-level grants from 0005, which cover the new column. couli_readonly
-- loses the table-level SELECT of 0005 and gets SELECT on every devices column except
-- install_secret_cipher: processes holding the field keys could decrypt a ciphertext read
-- through the read-only role and forge request signatures. A later migration that adds a
-- devices column must grant it to couli_readonly explicitly.
--
-- sessions / refresh_tokens are mutable entity tables (04 §3.2 通则; ADR-0001 §4.3): each has
-- a uuid id (UUIDv7 supplied by the application) and updated_at; sid stays its own column,
-- opaque text like devices.last_login_sid and push_tokens.bound_sid (neither gets a foreign
-- key to sessions here). Business keys start with app_id: (app_id, sid), (app_id, token_hash).
-- refresh_tokens stores token hashes only, never a token value (BR-ID-07); the hash function
-- and its encoding belong to identity, so there is no format CHECK. parent_hash references
-- the rotated predecessor in the same app and is unique: a token is rotated at most once
-- (BR-ID-07: R1 has one direct successor R2; a grace hit returns that same pair), so a
-- concurrent second rotation of R1 fails with 23505 instead of forking the chain.
-- Because of that self-referencing foreign key, a later cleanup of expired tokens must delete
-- a sid's whole chain in one statement (or its migration drops the foreign key); deleting by
-- expire_at alone would hit predecessors whose successors are still stored.
-- revoke_reason is open text: 04 and 08 give no closed vocabulary.
-- Revocation (revoked_at, revoke_reason) and rotation (rotated_at) fill NULL columns once:
-- writers put "... IS NULL" in the WHERE clause and treat 0 updated rows as already revoked
-- or rotated. There is no repeatable transition, so no row_version (as device_registrations
-- in 0005). Column grants keep sid, user_id, device_id, token_hash, parent_hash and expire_at
-- immutable for couli_app. Revoking a sid chain is a sessions write; tokens are judged through
-- their session. Deleting sessions or tokens (retention) is a later task: no DELETE grant.
-- sessions.created_at is compared with push_tokens.token_set_at (BR-ID-07 细则「推送令牌与
-- 会话」), so identity writes it from the injected Clock (ADR-0001 §4.2 #10) in the creating
-- INSERT; the default is only a fallback. All other business moments come from the Clock too.
--
-- consent_records is insert-only (BR-ID-12): couli_app gets SELECT and INSERT, never UPDATE or
-- DELETE. As for login_logs in 0005, the grants enforce this; no trigger, so a later retention
-- task can still remove expired rows under its own grant. It has an internal identity key
-- (ADR-0001 §4.2 #1); nothing references a consent row. The current state per (subject, type)
-- is the row with the latest server_at, served by the two indexes listed in 04.
-- subject_type, type and channel each have exactly one single-column CHECK whose values equal
-- BR-ID-12 and contracts/enums/identity.yaml (consent_type, consent_channel).
-- Coupled CHECKs: a user record names its user and a device record its device; device_id
-- stays optional on user records (h5_landing registers outside the App, BR-ID-32) and user_id
-- is only an association on device records (BR-ID-13). labor_agreement is user-level only
-- (BR-ID-12) and stores text_sha256, the signer snapshot (BR-WDR-31 细则) and device_id
-- (BR-WDR-31 lists it among the retained fields; signing happens only in the native App);
-- other types may leave text_sha256 and signer_snapshot NULL. The snapshot's JSON keys belong
-- to the signing service.
-- Consent rows are kept with the tombstone user_id after account deletion (BR-ID-28); their
-- foreign keys therefore keep referenced users and devices rows from being deleted (BR-ID-28
-- lists device records under "删除或匿名化").

ALTER TABLE app.devices ADD COLUMN install_secret_cipher bytea;

-- One-time backfill (see the header): revoke every existing device, empty placeholder key.
UPDATE app.devices
SET install_secret_cipher = ''::bytea,
    revoked_at = COALESCE(revoked_at, last_seen_at),
    row_version = row_version + 1;

ALTER TABLE app.devices ALTER COLUMN install_secret_cipher SET NOT NULL;

ALTER TABLE app.devices ADD CONSTRAINT devices_install_secret_present_check
  CHECK (revoked_at IS NOT NULL OR octet_length(install_secret_cipher) > 0);

ALTER TABLE app.devices DROP COLUMN install_secret_hash;

CREATE TABLE app.sessions (
  id            uuid NOT NULL,
  app_id        text NOT NULL,
  sid           text NOT NULL,
  user_id       uuid NOT NULL,
  device_id     uuid NOT NULL,
  revoked_at    timestamptz,
  revoke_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_pkey PRIMARY KEY (id),
  CONSTRAINT sessions_sid_key UNIQUE (app_id, sid),
  CONSTRAINT sessions_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT sessions_device_fkey FOREIGN KEY (app_id, device_id)
    REFERENCES app.devices (app_id, id)
);

-- Revoking all sessions of a user (ban, merge, phone change) or of a device (BR-ID-13).
CREATE INDEX sessions_user_idx ON app.sessions (app_id, user_id);
CREATE INDEX sessions_device_idx ON app.sessions (app_id, device_id);

CREATE TABLE app.refresh_tokens (
  id          uuid NOT NULL,
  app_id      text NOT NULL,
  sid         text NOT NULL,
  token_hash  text NOT NULL,
  parent_hash text,
  rotated_at  timestamptz,
  expire_at   timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT refresh_tokens_token_hash_key UNIQUE (app_id, token_hash),
  CONSTRAINT refresh_tokens_parent_hash_key UNIQUE (app_id, parent_hash),
  CONSTRAINT refresh_tokens_session_fkey FOREIGN KEY (app_id, sid)
    REFERENCES app.sessions (app_id, sid),
  CONSTRAINT refresh_tokens_parent_fkey FOREIGN KEY (app_id, parent_hash)
    REFERENCES app.refresh_tokens (app_id, token_hash)
);

CREATE INDEX refresh_tokens_session_idx ON app.refresh_tokens (app_id, sid);

CREATE TABLE app.consent_records (
  id              bigint GENERATED ALWAYS AS IDENTITY,
  app_id          text NOT NULL,
  subject_type    text NOT NULL,
  user_id         uuid,
  device_id       uuid,
  type            text NOT NULL,
  version         integer NOT NULL,
  channel         text NOT NULL,
  accepted        boolean NOT NULL,
  client_at       timestamptz NOT NULL,
  server_at       timestamptz NOT NULL,
  text_sha256     text,
  signer_snapshot jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consent_records_pkey PRIMARY KEY (id),
  CONSTRAINT consent_records_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT consent_records_device_fkey FOREIGN KEY (app_id, device_id)
    REFERENCES app.devices (app_id, id),
  CONSTRAINT consent_records_subject_type_check CHECK (subject_type IN ('user', 'device')),
  CONSTRAINT consent_records_type_check CHECK (
    type IN (
      'privacy', 'agreement', 'ai_third_party', 'id_verification', 'personalization',
      'labor_agreement'
    )
  ),
  CONSTRAINT consent_records_channel_check CHECK (
    channel IN (
      'first_launch', 'login_page', 'h5_landing', 'agent_sheet', 'realname_sheet',
      'privacy_center', 'login_merge', 'withdraw_flow'
    )
  ),
  CONSTRAINT consent_records_subject_check CHECK (
    (subject_type = 'user' AND user_id IS NOT NULL)
    OR (subject_type = 'device' AND device_id IS NOT NULL)
  ),
  CONSTRAINT consent_records_labor_agreement_check CHECK (
    type <> 'labor_agreement'
    OR (
      subject_type = 'user' AND text_sha256 IS NOT NULL AND signer_snapshot IS NOT NULL
      AND device_id IS NOT NULL
    )
  )
);

-- 04 §3.2: (app_id, subject_type, user_id|device_id, type, server_at DESC).
CREATE INDEX consent_records_user_type_idx
  ON app.consent_records (app_id, subject_type, user_id, type, server_at DESC);
CREATE INDEX consent_records_device_type_idx
  ON app.consent_records (app_id, subject_type, device_id, type, server_at DESC);

GRANT SELECT, INSERT ON app.sessions, app.refresh_tokens, app.consent_records TO couli_app;
GRANT UPDATE (revoked_at, revoke_reason, updated_at) ON app.sessions TO couli_app;
GRANT UPDATE (rotated_at, updated_at) ON app.refresh_tokens TO couli_app;
GRANT SELECT ON app.sessions, app.refresh_tokens, app.consent_records TO couli_readonly;
-- Every devices column except install_secret_cipher (see the header).
REVOKE SELECT ON app.devices FROM couli_readonly;
GRANT SELECT (
  id, app_id, user_id, device_hash, id_source, platform, app_version, last_login_sid,
  revoked_at, last_seen_at, row_version, created_at, updated_at
) ON app.devices TO couli_readonly;
