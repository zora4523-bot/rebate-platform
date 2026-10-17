-- Up Migration
-- Real-name records app.realname and deletion tombstones app.deleted_identities (规划/04 §3.2 表行,
-- §2.5 realname_status; BR-ID-25 实名核验, BR-ID-28 注销, BR-ID-06 换号, BR-ID-30 ⑩ 留存;
-- ADR-0001 §4). Task B1-13b (orchestrator ruling E5: both tables in one migration).
-- Compatibility: additive (two new tables, their constraints, indexes and grants; nothing existing
-- changes, app.users is only referenced). Recovery: restore from backup; no down migration.
--
-- app.realname, at most one row per user (unique (app_id, user_id)):
--   id                 uuid primary key, UUIDv7 supplied by the application (the labour-contract
--                      signing snapshot and bank-card verification fingerprint cite this record ID);
--                      unique (app_id, id) so later tables can reference it tenant-qualified.
--   app_id, user_id    FK app.users (app_id, id), no cascade.
--   name_cipher, id_no_cipher, birth_date_cipher
--                      bytea ciphertext (FieldCrypto); no plaintext personal data is stored.
--   id_no_hmac         blind index, 64 lowercase hex characters (FieldCrypto.blindIndex).
--   status             realname_status none / verified / failed (04 §2.5), no default.
--   provider           verification vendor, opaque non-blank text when present.
--   verified_at        verification instant (application Clock, no SQL default).
--   row_version        CAS version for writers.
--   No adult_at / birth_year: ages 14 and 18 derive from the decrypted birth date (BR-ID-25, C-15).
--   Shape: verified requires all four cipher / HMAC columns, provider and verified_at; none and
--   failed keep no cipher and no HMAC (BR-ID-25: failures store no name or ID; anonymisation on
--   account deletion, BR-ID-28, clears them and sets status = none).
--   (app_id, id_no_hmac) is unique among verified rows only (partial unique index), so clearing a
--   record releases the ID for another account.
--
-- app.deleted_identities, one row per identifier set, insert-only, deleted when expired:
--   id                 bigint identity.
--   reason             account_deleted (BR-ID-28) / phone_changed (BR-ID-06).
--   phone_hmac         HMAC of the normalised phone number, 64 lowercase hex.
--   device_hash        hash of a registered device, 64 lowercase hex (same format as
--                      login_logs.device_hash); never set for phone_changed.
--   deleted_at, expire_at
--                      application Clock values; expire_at > deleted_at. The 180-day retention is
--                      computed by the writer from 08, never hard-coded here.
--   No user_id (04 has none; tombstones keep no direct identifier, BR-ID-28) and no unique key
--   (the same number can be changed away more than once). Lookups by (app_id, phone_hmac) /
--   (app_id, device_hash) for the new-user reward check; (expire_at) for the BR-ID-30 ⑩ purge
--   (deletes rows with expire_at < run time).
--
-- Grants (orchestrator rulings §9.3 #4, E20):
--   realname: couli_app SELECT, INSERT and column UPDATE on the cipher / HMAC columns, status,
--   provider, verified_at, row_version, updated_at (verification, admin correction, anonymisation);
--   no DELETE and no update of id / app_id / user_id / created_at. couli_readonly column SELECT on
--   the non-sensitive columns only (precedent admin_users: no ciphertext, no HMAC).
--   deleted_identities: couli_app SELECT, INSERT, DELETE (expiry purge), no UPDATE;
--   couli_readonly SELECT. No append-only trigger (expired rows must be deletable); immutability
--   comes from the missing UPDATE grant. The identity sequence needs no grant (GENERATED ALWAYS).
-- All constraints and indexes are named.
--
-- Timeouts: two new empty tables; CREATE TABLE / INDEX are instant, but the foreign key takes
-- SHARE ROW EXCLUSIVE on app.users. 5s lock wait so a blocked deploy fails fast instead of queueing
-- traffic behind it, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.realname (
  id                uuid NOT NULL,
  app_id            text NOT NULL,
  user_id           uuid NOT NULL,
  name_cipher       bytea,
  id_no_cipher      bytea,
  id_no_hmac        text,
  birth_date_cipher bytea,
  status            text NOT NULL,
  provider          text,
  verified_at       timestamptz,
  row_version       integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT realname_pkey PRIMARY KEY (id),
  CONSTRAINT realname_app_id_key UNIQUE (app_id, id),
  CONSTRAINT realname_user_key UNIQUE (app_id, user_id),
  CONSTRAINT realname_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT realname_status_check CHECK (status IN ('none', 'verified', 'failed')),
  CONSTRAINT realname_verified_check CHECK (
    status <> 'verified' OR (
      name_cipher IS NOT NULL AND id_no_cipher IS NOT NULL AND id_no_hmac IS NOT NULL
      AND birth_date_cipher IS NOT NULL AND provider IS NOT NULL AND verified_at IS NOT NULL
    )
  ),
  CONSTRAINT realname_unverified_cleared_check CHECK (
    status = 'verified' OR (
      name_cipher IS NULL AND id_no_cipher IS NULL AND id_no_hmac IS NULL
      AND birth_date_cipher IS NULL
    )
  ),
  CONSTRAINT realname_id_no_hmac_check
    CHECK (id_no_hmac IS NULL OR id_no_hmac ~ '^[0-9a-f]{64}$'),
  CONSTRAINT realname_provider_check
    CHECK (provider IS NULL OR provider ~ '[^[:space:]]')
);

CREATE UNIQUE INDEX realname_verified_id_no_hmac_key
  ON app.realname (app_id, id_no_hmac)
  WHERE status = 'verified';

CREATE TABLE app.deleted_identities (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  app_id      text NOT NULL,
  reason      text NOT NULL,
  phone_hmac  text,
  device_hash text,
  deleted_at  timestamptz NOT NULL,
  expire_at   timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deleted_identities_pkey PRIMARY KEY (id),
  CONSTRAINT deleted_identities_reason_check
    CHECK (reason IN ('account_deleted', 'phone_changed')),
  CONSTRAINT deleted_identities_identifier_check
    CHECK (num_nonnulls(phone_hmac, device_hash) >= 1),
  CONSTRAINT deleted_identities_phone_changed_check
    CHECK (reason <> 'phone_changed' OR (phone_hmac IS NOT NULL AND device_hash IS NULL)),
  CONSTRAINT deleted_identities_phone_hmac_check
    CHECK (phone_hmac IS NULL OR phone_hmac ~ '^[0-9a-f]{64}$'),
  CONSTRAINT deleted_identities_device_hash_check
    CHECK (device_hash IS NULL OR device_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT deleted_identities_expiry_check CHECK (expire_at > deleted_at)
);

CREATE INDEX deleted_identities_phone_hmac_idx
  ON app.deleted_identities (app_id, phone_hmac)
  WHERE phone_hmac IS NOT NULL;

CREATE INDEX deleted_identities_device_hash_idx
  ON app.deleted_identities (app_id, device_hash)
  WHERE device_hash IS NOT NULL;

CREATE INDEX deleted_identities_expire_at_idx
  ON app.deleted_identities (expire_at);

GRANT SELECT, INSERT ON app.realname TO couli_app;
GRANT UPDATE (
  name_cipher, id_no_cipher, id_no_hmac, birth_date_cipher, status, provider, verified_at,
  row_version, updated_at
) ON app.realname TO couli_app;
GRANT SELECT (
  id, app_id, user_id, status, provider, verified_at, row_version, created_at, updated_at
) ON app.realname TO couli_readonly;

GRANT SELECT, INSERT, DELETE ON app.deleted_identities TO couli_app;
GRANT SELECT ON app.deleted_identities TO couli_readonly;
