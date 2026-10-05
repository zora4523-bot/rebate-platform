-- Up Migration
-- Admin account baseline (规划/04 §3.2 row admin_users / admin_permissions / audit_logs;
-- BR-ID-34, BR-ID-33, BR-ID-30 ⑧; 拍板第二批 §8 ADD-04; docs/changes/20261004-后台设计稿拍板.md
-- §3; SPEC_REF 1955639; ADR-0001 §4). Also adds the union_accounts.auth_renewed_by foreign key
-- announced in 0015.
-- Compatibility: additive (three new tables). The new union_accounts foreign key is validated
-- at creation: a local or staging database whose union_accounts rows carry auth_renewed_by
-- values without an admin_users row must clear those values first (nothing is released, so
-- no production data exists). Recovery: restore from backup; no down migration.
-- Writer of all three tables: admin (规划/02). Entity UUIDs are UUIDv7 supplied by the
-- application; business moments (totp_bound_at, verify_phone_set_at, granted_at, at) come from
-- the injected Clock and have no SQL default. Storage only: login, lockout, TOTP binding,
-- step-up, encryption, masking and audit writing belong to the admin module.
--
-- admin_users: one row per back-office account. The account name (login_name) is unique over
-- the whole table, across apps and every status, and is never released when an account is
-- disabled (orchestrator ruling; the owner has not decided whether disabled names may be
-- reused). password_hash holds only the password hash string produced by the admin module
-- (algorithm and encoding are its choice, so no format CHECK); no plaintext password column
-- exists. totp_secret_cipher and verify_phone_cipher hold only field-encryption ciphertext
-- (bytea with the UTF-8 bytes of the platform envelope v1.<key_version>.<payload>, as
-- users.phone_cipher; BR-ID-33), never the secret or phone number. verify_phone_hmac is the
-- HMAC blind index (text, as users.phone_hmac); no uniqueness is imposed on it (04 names
-- none). totp_bound_at NULL means TOTP is not bound: the first login must bind it first
-- (BR-ID-34 细则「首次绑定身份验证器」); totp_secret_cipher may already be set during binding,
-- so the two columns are not coupled by a CHECK. verify_phone_set_at NULL means no
-- verification phone is registered, so the account cannot perform SMS-tier step-up
-- operations (BR-ID-34). totp_last_step is the 30-second TOTP time step of the most recently
-- accepted code (NULL until a code is accepted); it lets the admin module consume a code at
-- most once across processes and runs with a conditional update
-- (WHERE totp_last_step IS NULL OR totp_last_step < :step), so replay protection lands in PG
-- (AGENTS.md §4.4). It is not a secret. is_super has no default and no trigger: a super admin
-- owns every permission point and never appears in admin_permissions (ADD-04); who may set it
-- is enforced by the admin module. status is open text: 04, 08 and contracts give no
-- admin-status vocabulary, so the writer states it on creation and no CHECK is added. No
-- other required string column exists besides the account name and the password hash.
-- Grants: couli_app gets SELECT, INSERT and UPDATE on every column except id, app_id,
-- login_name and created_at (the account name is immutable); no DELETE (accounts are
-- disabled, never removed, so audit and grant references stay valid). couli_readonly may read
-- every column except password_hash, totp_secret_cipher, verify_phone_cipher and
-- verify_phone_hmac: processes holding the field or HMAC keys could otherwise recover secrets
-- or phone numbers read through the read-only role. A later migration that adds a column must
-- grant it to couli_readonly explicitly.
--
-- admin_permissions: one row per permission point ticked for an ordinary account (no role
-- templates; admin_roles does not exist, ADD-04). Unique (app_id, admin_id, permission_key)
-- regardless of grantor or time. permission_key values come from contracts/enums/admin.yaml
-- admin_permission; there is deliberately no CHECK or enum so contract additions need no
-- migration. Ticking inserts a row, revoking deletes it; there is no UPDATE. Only super admins
-- may tick or revoke, with step-up and an audit_logs row (BR-ID-34) — enforced by the admin
-- module. granted_by is the granting super admin in the same app.
--
-- audit_logs: insert-only (BR-ID-34). couli_app gets SELECT and INSERT only, and an
-- unconditional BEFORE UPDATE OR DELETE trigger (app.reject_update_delete, db/AGENTS.md #8)
-- rejects both for every role including the owner. Not partitioned: ADR-0001 §4.2 #5 does not
-- list it, and 0011's drop_expired_month_partitions refuses it; retention is ≥ 3 years with no
-- automatic deletion until legal confirms (BR-ID-30 ⑧). before / after are jsonb snapshots
-- that the writer must mask first: no plaintext phone, ID number, payout account, TOTP secret
-- or password ever enters them (BR-ID-33); likewise target holds an identifier, not personal
-- data. admin_id is the acting admin; target and ip may be NULL for actions without a single
-- object or without a client address; before / after are NULL when there is no prior or
-- resulting state. id is an internal identity key; nothing references an audit row.
--
-- Every foreign key references (app_id, id) of admin_users, so no row can name an admin of
-- another app. No foreign key cascades.

CREATE TABLE app.admin_users (
  id                  uuid NOT NULL,
  app_id              text NOT NULL,
  login_name          text NOT NULL,
  password_hash       text NOT NULL,
  totp_secret_cipher  bytea,
  totp_bound_at       timestamptz,
  totp_last_step      bigint,
  is_super            boolean NOT NULL,
  status              text NOT NULL,
  verify_phone_cipher bytea,
  verify_phone_hmac   text,
  verify_phone_set_at timestamptz,
  row_version         integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_users_pkey PRIMARY KEY (id),
  CONSTRAINT admin_users_app_id_id_key UNIQUE (app_id, id),
  CONSTRAINT admin_users_login_name_key UNIQUE (login_name)
);

CREATE TABLE app.admin_permissions (
  id             bigint GENERATED ALWAYS AS IDENTITY,
  app_id         text NOT NULL,
  admin_id       uuid NOT NULL,
  permission_key text NOT NULL,
  granted_by     uuid NOT NULL,
  granted_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_permissions_pkey PRIMARY KEY (id),
  CONSTRAINT admin_permissions_admin_permission_key UNIQUE (app_id, admin_id, permission_key),
  CONSTRAINT admin_permissions_admin_fkey FOREIGN KEY (app_id, admin_id)
    REFERENCES app.admin_users (app_id, id),
  CONSTRAINT admin_permissions_granted_by_fkey FOREIGN KEY (app_id, granted_by)
    REFERENCES app.admin_users (app_id, id)
);

CREATE INDEX admin_permissions_granted_by_idx ON app.admin_permissions (app_id, granted_by);

CREATE TABLE app.audit_logs (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  app_id     text NOT NULL,
  admin_id   uuid NOT NULL,
  action     text NOT NULL,
  target     text,
  before     jsonb,
  after      jsonb,
  ip         inet,
  at         timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_pkey PRIMARY KEY (id),
  CONSTRAINT audit_logs_admin_fkey FOREIGN KEY (app_id, admin_id)
    REFERENCES app.admin_users (app_id, id)
);

CREATE INDEX audit_logs_at_idx ON app.audit_logs (app_id, at);
CREATE INDEX audit_logs_admin_at_idx ON app.audit_logs (app_id, admin_id, at);
CREATE INDEX audit_logs_target_idx ON app.audit_logs (app_id, target, at);

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON app.audit_logs
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

-- auth_renewed_by: the admin who last renewed the union authorization (0015 header).
ALTER TABLE app.union_accounts ADD CONSTRAINT union_accounts_auth_renewed_by_fkey
  FOREIGN KEY (app_id, auth_renewed_by) REFERENCES app.admin_users (app_id, id);

CREATE INDEX union_accounts_auth_renewed_by_idx
  ON app.union_accounts (app_id, auth_renewed_by) WHERE auth_renewed_by IS NOT NULL;

GRANT SELECT, INSERT ON app.admin_users TO couli_app;
GRANT UPDATE (password_hash, totp_secret_cipher, totp_bound_at, totp_last_step, is_super, status,
              verify_phone_cipher, verify_phone_hmac, verify_phone_set_at, row_version,
              updated_at)
  ON app.admin_users TO couli_app;
GRANT SELECT, INSERT, DELETE ON app.admin_permissions TO couli_app;
GRANT SELECT, INSERT ON app.audit_logs TO couli_app;

GRANT SELECT (id, app_id, login_name, totp_bound_at, totp_last_step, is_super, status,
              verify_phone_set_at, row_version, created_at, updated_at)
  ON app.admin_users TO couli_readonly;
GRANT SELECT ON app.admin_permissions, app.audit_logs TO couli_readonly;
