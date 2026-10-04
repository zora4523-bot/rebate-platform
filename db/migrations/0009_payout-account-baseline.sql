-- Up Migration
-- Payout-account baseline (规划/04 §3.2; BR-WDR-02; SPEC_REF 826f86e; ADR-0001 §4).
-- Compatibility: additive. Recovery: restore from backup; no down migration.
-- Entity UUIDs are UUIDv7 supplied by the application; changes use an internal identity.
-- User foreign keys include app_id and never cascade. The apps table does not exist yet;
-- its foreign keys await the apps baseline migration.
--
-- Writer: withdraw (couli_app), including verification takeover/recheck workers.
-- All account saves lock the user's users row first, then reread the current binding and
-- monthly change count. Account replacement, the counted change, step_up_token consumption
-- and the request's idempotent result commit together. First binding and same-account
-- submissions do not insert a change. Both payout methods share the monthly change count.
-- Verification reservations use that same user lock: recheck the key's result, then its
-- bound attempt (all statuses), then the fingerprint, then the daily quota before INSERT.
-- Vendor calls/queries run outside the lock; request results and business results commit
-- together. Background takeover/recheck only updates attempts, never payout_accounts.
-- CAS writers compare the old state and row_version and increment the version together;
-- state transitions, quotas, leases and reuse deadlines belong to the application.
-- verify_date is the +08:00 calendar date from the injected Clock; all business timestamps
-- are supplied by that Clock. No trigger performs a business transition.
--
-- BR-WDR-02 / b2-m01: normalize the Alipay login BEFORE encryption and alipay_hmac.
-- Apply Unicode NFKC and remove all whitespace and zero-width characters. Email forms
-- (containing @) are lowercased and must have exactly one @ with nonempty local/domain
-- parts. Phone forms use the SAME normalize_phone as login (BR-ID-05), yielding a valid
-- mainland 11-digit number; reject foreign numbers rather than guessing by stripping digits.
-- Encrypt and HMAC that normalized value; use it for payout and every HMAC comparison.
-- Bank card numbers lose spaces/hyphens and are validated before encryption/HMAC.
-- payee_name stores the normalized name: NFKC, trim surrounding whitespace (including
-- U+3000/U+00A0), map U+2022/U+002E/U+FF0E/U+30FB to U+00B7, then compare with realname.
-- HMACs use text as in users.phone_hmac. operator is an opaque audit identity, not an enum.
-- request_fingerprint is a canonical encoding of the realname record ID and card HMAC;
-- it must never contain a plaintext card number. No vendor or BIN dataset is assumed here.

CREATE TABLE app.payout_accounts (
  id                     uuid NOT NULL,
  app_id                 text NOT NULL,
  user_id                uuid NOT NULL,
  payout_method          text NOT NULL,
  alipay_logon_id_cipher  bytea,
  alipay_hmac             text,
  bank_card_no_cipher    bytea,
  bank_card_hmac          text,
  bank_name              text,
  card_bin               text,
  payee_name             text NOT NULL,
  is_current             boolean NOT NULL,
  row_version            integer NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT payout_accounts_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT payout_accounts_method_check CHECK (payout_method IN ('alipay', 'bank_card')),
  CONSTRAINT payout_accounts_details_check CHECK (
    (payout_method = 'alipay'
      AND alipay_logon_id_cipher IS NOT NULL AND alipay_hmac IS NOT NULL
      AND bank_card_no_cipher IS NULL AND bank_card_hmac IS NULL
      AND bank_name IS NULL AND card_bin IS NULL)
    OR (payout_method = 'bank_card'
      AND bank_card_no_cipher IS NOT NULL AND bank_card_hmac IS NOT NULL
      AND bank_name IS NOT NULL AND card_bin IS NOT NULL
      AND alipay_logon_id_cipher IS NULL AND alipay_hmac IS NULL)
  )
);

CREATE UNIQUE INDEX payout_accounts_current_alipay_key
  ON app.payout_accounts (app_id, alipay_hmac) WHERE is_current;
CREATE UNIQUE INDEX payout_accounts_current_bank_card_key
  ON app.payout_accounts (app_id, bank_card_hmac) WHERE is_current;
CREATE UNIQUE INDEX payout_accounts_current_user_key
  ON app.payout_accounts (app_id, user_id) WHERE is_current;

CREATE TABLE app.payout_account_changes (
  id                 bigint GENERATED ALWAYS AS IDENTITY,
  app_id             text NOT NULL,
  user_id            uuid NOT NULL,
  old_payout_method  text NOT NULL,
  new_payout_method  text NOT NULL,
  old_hmac           text NOT NULL,
  new_hmac           text NOT NULL,
  operator           text NOT NULL,
  changed_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_account_changes_pkey PRIMARY KEY (id),
  CONSTRAINT payout_account_changes_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT payout_account_changes_old_method_check
    CHECK (old_payout_method IN ('alipay', 'bank_card')),
  CONSTRAINT payout_account_changes_new_method_check
    CHECK (new_payout_method IN ('alipay', 'bank_card'))
);

CREATE INDEX payout_account_changes_user_changed_idx
  ON app.payout_account_changes (app_id, user_id, changed_at);

CREATE TRIGGER payout_account_changes_append_only
  BEFORE UPDATE OR DELETE ON app.payout_account_changes
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

CREATE TABLE app.payout_account_verify_attempts (
  id                   uuid NOT NULL,
  app_id               text NOT NULL,
  user_id              uuid NOT NULL,
  verify_date          date NOT NULL,
  status               text NOT NULL,
  vendor_request_id    text NOT NULL,
  request_fingerprint  text NOT NULL,
  reserved_at          timestamptz NOT NULL,
  unknown_at           timestamptz,
  resolved_at          timestamptz,
  origin_action        text NOT NULL,
  idempotency_key      text,
  row_version          integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_account_verify_attempts_pkey PRIMARY KEY (id),
  CONSTRAINT payout_account_verify_attempts_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT payout_account_verify_attempts_vendor_key UNIQUE (app_id, vendor_request_id),
  CONSTRAINT payout_account_verify_attempts_status_check CHECK (
    status IN ('reserved', 'matched', 'mismatched', 'unknown', 'expired_unresolved', 'released')
  ),
  CONSTRAINT payout_account_verify_attempts_action_check
    CHECK (origin_action = 'payout_account_change')
);

CREATE UNIQUE INDEX payout_account_verify_attempts_inflight_key
  ON app.payout_account_verify_attempts (app_id, user_id, request_fingerprint)
  WHERE status IN ('reserved', 'unknown');
-- Deliberately independent of status AND verify_date: retries on another day keep the
-- original attempt and cannot reserve/pay for verification again under the same key.
CREATE UNIQUE INDEX payout_account_verify_attempts_idempotency_key
  ON app.payout_account_verify_attempts (app_id, user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX payout_account_verify_attempts_fingerprint_reserved_idx
  ON app.payout_account_verify_attempts (app_id, user_id, request_fingerprint, reserved_at);
CREATE INDEX payout_account_verify_attempts_user_date_idx
  ON app.payout_account_verify_attempts (app_id, user_id, verify_date);

-- Replacement inserts a new account; only the old account's current marker is mutable.
-- Attempts preserve their original ownership, date, fingerprint, vendor ID and key.
GRANT SELECT, INSERT ON app.payout_accounts, app.payout_account_changes,
  app.payout_account_verify_attempts TO couli_app;
GRANT UPDATE (is_current, row_version, updated_at) ON app.payout_accounts TO couli_app;
GRANT UPDATE (status, unknown_at, resolved_at, row_version, updated_at)
  ON app.payout_account_verify_attempts TO couli_app;
GRANT SELECT ON app.payout_accounts, app.payout_account_changes,
  app.payout_account_verify_attempts TO couli_readonly;
