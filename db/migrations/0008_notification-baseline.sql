-- Up Migration
-- Notification and tip-read baseline (规划/04 §3.2; ADR-0001 §4).
-- Compatibility: additive. Recovery: restore from backup; no down migration.
-- Entity UUIDs (id and message_id) are UUIDv7 supplied by the application.
-- User/device references include app_id; the device FK uses the index added in 0006.
-- The apps table does not exist yet; its foreign keys await the apps baseline migration.
-- Session IDs are opaque text, as in devices.last_login_sid; sessions are stored elsewhere.
-- provider remains open text until the provider selection (D-14).
--
-- Writers: notification owns push_tokens and inbox_messages; growth owns user_tip_reads.
-- Token moves, conflict freezes and session binding are application transactions locking
-- the device row. All token/read moments come from the injected application Clock.
-- Re-reporting the same token must preserve token_set_at; acquired_by_move_at records a
-- move onto this row. frozen_until is token-local, independent of user_risk_state.
-- The partial unique index retains a frozen holder's claim until it is revoked/deleted.
-- No trigger implements binding, movement, freezing or any other business transition.
--
-- CAS (ADR-0001 §4.1, as in 0005/0006): push_tokens and inbox_messages start row_version
-- at 0. Writers compare the old state/version and increment it in the same UPDATE.
-- user_tip_reads is inserted on display and deleted on reset, never updated: no version.
-- Invalid tokens and reset tip reads require application DELETE; inbox retention is a
-- later task and does not grant application DELETE here.

CREATE TABLE app.push_tokens (
  id                  uuid NOT NULL,
  app_id              text NOT NULL,
  user_id             uuid,
  bound_sid           text,
  device_id           uuid NOT NULL,
  provider            text NOT NULL,
  token               text NOT NULL,
  token_set_at        timestamptz NOT NULL,
  acquired_by_move_at  timestamptz,
  frozen_until        timestamptz,
  revoked_at          timestamptz,
  row_version         integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT push_tokens_device_provider_key UNIQUE (app_id, device_id, provider),
  CONSTRAINT push_tokens_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT push_tokens_device_fkey FOREIGN KEY (app_id, device_id)
    REFERENCES app.devices (app_id, id)
);

CREATE UNIQUE INDEX push_tokens_live_token_key ON app.push_tokens (app_id, provider, token)
  WHERE revoked_at IS NULL;

CREATE INDEX push_tokens_user_bound_sid_idx ON app.push_tokens (app_id, user_id, bound_sid);

CREATE TABLE app.user_tip_reads (
  app_id      text NOT NULL,
  user_id     uuid NOT NULL,
  tip_key     text NOT NULL,
  platform    text NOT NULL,
  read_at     timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_tip_reads_pkey PRIMARY KEY (app_id, user_id, tip_key, platform),
  CONSTRAINT user_tip_reads_tip_key_check CHECK (tip_key IN ('jump_tip', 'inviter_before_buy')),
  CONSTRAINT user_tip_reads_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id)
);

CREATE TABLE app.inbox_messages (
  message_id   uuid NOT NULL,
  app_id       text NOT NULL,
  user_id      uuid NOT NULL,
  code         text NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL,
  route        jsonb,
  read_at      timestamptz,
  row_version  integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_messages_pkey PRIMARY KEY (message_id),
  CONSTRAINT inbox_messages_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id)
);

CREATE INDEX inbox_messages_user_created_idx
  ON app.inbox_messages (app_id, user_id, created_at, message_id);

GRANT SELECT, INSERT, DELETE ON app.push_tokens, app.user_tip_reads TO couli_app;
GRANT UPDATE (user_id, bound_sid, token, token_set_at, acquired_by_move_at, frozen_until,
  revoked_at, row_version, updated_at) ON app.push_tokens TO couli_app;
GRANT SELECT, INSERT ON app.inbox_messages TO couli_app;
GRANT UPDATE (read_at, row_version, updated_at) ON app.inbox_messages TO couli_app;
GRANT SELECT ON app.push_tokens, app.user_tip_reads, app.inbox_messages TO couli_readonly;
