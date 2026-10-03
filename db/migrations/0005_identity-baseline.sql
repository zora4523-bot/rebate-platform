-- Up Migration
-- Identity baseline (规划/04 §3.2; BR-ID-05, BR-ID-06, BR-ID-09; ADR-0001 §4).
-- Compatibility: additive. Recovery: restore from backup; no down migration.
-- users.phone_cipher and phone_hmac MUST be written from the phone number normalized
-- according to BR-ID-05 细则「手机号规范化」. Never compute an HMAC of an unnormalized value.
--
-- Choices where 04 does not give a complete enum: status is text, with 'normal' as the
-- implementation label/default for an ordinary account; 'deleting' and 'deleted' remain
-- accepted. deleted_reason is open text (including 'merged'). register_method, login
-- method (including 'merge'), level and parent_bind_source are also open text: no invented
-- closed business enums. Risk state is not stored here. nickname_change_month stores
-- YYYY-MM; avatar stores the default avatar reference supplied by the application (OPS-13).
-- Phone fields are nullable for third-party accounts and deletion tombstones.
--
-- Entity UUIDs are supplied by the application; login_logs uses an internal identity key.
-- Session IDs are opaque text (sessions live outside these five tables); last_login_sid
-- starts NULL and identity must write it in the same transaction as session creation.
-- app_id is text, consistent with 0003; the apps table does not exist yet. Its foreign
-- keys belong to the later apps baseline migration. User references include app_id.
-- All five tables are unpartitioned (ADR-0001 §4.2 #5). Retention deletion is a later task.

CREATE TABLE app.users (
  id                    uuid NOT NULL,
  app_id                text NOT NULL,
  phone_cipher          bytea,
  phone_hmac            text,
  nickname              text NOT NULL,
  avatar                text NOT NULL,
  nickname_change_month text,
  nickname_change_count integer NOT NULL DEFAULT 0,
  invite_code           text NOT NULL,
  attr_code             text NOT NULL,
  parent_id             uuid,
  parent_bind_source    text,
  parent_bound_at       timestamptz,
  self_bind_used        boolean NOT NULL DEFAULT false,
  level                 text NOT NULL,
  status                text NOT NULL DEFAULT 'normal',
  deleted_reason        text,
  personalization_off   boolean NOT NULL DEFAULT false,
  register_method       text NOT NULL,
  registered_channel    text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_app_id_id_key UNIQUE (app_id, id),
  CONSTRAINT users_invite_code_key UNIQUE (app_id, invite_code),
  CONSTRAINT users_attr_code_key UNIQUE (app_id, attr_code),
  CONSTRAINT users_parent_fkey FOREIGN KEY (app_id, parent_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT users_nickname_change_month_check
    CHECK (nickname_change_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);

-- Deleting accounts still occupy the phone; deleted accounts (including merge tombstones)
-- do not. NULL allows multiple accounts without a phone number.
CREATE UNIQUE INDEX users_phone_hmac_key ON app.users (app_id, phone_hmac)
  WHERE status <> 'deleted';

CREATE TABLE app.devices (
  id                  uuid NOT NULL,
  app_id              text NOT NULL,
  user_id             uuid,
  device_hash         text NOT NULL,
  id_source           text NOT NULL,
  install_secret_hash text NOT NULL,
  platform            text NOT NULL,
  app_version         text NOT NULL,
  last_login_sid      text,
  revoked_at          timestamptz,
  last_seen_at        timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_pkey PRIMARY KEY (id),
  CONSTRAINT devices_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT devices_id_source_check CHECK (id_source IN ('idfv', 'android_id', 'oaid', 'odid')),
  CONSTRAINT devices_device_hash_check CHECK (device_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE app.user_oauth (
  id                  uuid NOT NULL,
  app_id              text NOT NULL,
  user_id             uuid NOT NULL,
  provider            text NOT NULL,
  union_id            text NOT NULL,
  open_id             text,
  merged_from_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_oauth_pkey PRIMARY KEY (id),
  CONSTRAINT user_oauth_provider_check CHECK (provider IN ('wechat', 'apple', 'huawei')),
  CONSTRAINT user_oauth_identity_key UNIQUE (app_id, provider, union_id),
  CONSTRAINT user_oauth_user_provider_key UNIQUE (app_id, user_id, provider),
  CONSTRAINT user_oauth_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT user_oauth_merged_from_fkey FOREIGN KEY (app_id, merged_from_user_id)
    REFERENCES app.users (app_id, id)
);

CREATE TABLE app.login_logs (
  id             bigint GENERATED ALWAYS AS IDENTITY,
  app_id         text NOT NULL,
  user_id        uuid NOT NULL,
  device_id_hash text NOT NULL,
  ip             inet NOT NULL,
  method         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT login_logs_pkey PRIMARY KEY (id),
  CONSTRAINT login_logs_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id)
);

CREATE TABLE app.device_registrations (
  app_id              text NOT NULL,
  device_hash         text NOT NULL,
  user_id             uuid NOT NULL,
  register_method     text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  merged_into_user_id  uuid,
  CONSTRAINT device_registrations_pkey PRIMARY KEY (app_id, user_id),
  CONSTRAINT device_registrations_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT device_registrations_merged_into_fkey FOREIGN KEY (app_id, merged_into_user_id)
    REFERENCES app.users (app_id, id)
);

CREATE INDEX device_registrations_device_created_idx
  ON app.device_registrations (app_id, device_hash, created_at);

-- A prohibitive UPDATE guard (db/AGENTS.md #8), not a procedure performing a merge.
-- Column grants protect the immutable fields; the guard additionally prevents rewriting
-- or clearing the merge target, including concurrent attempts serialized by the row lock.
-- It makes no business writes and does not acquire a device lock.
CREATE FUNCTION app.reject_device_registration_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.merged_into_user_id IS NOT NULL
    OR NEW.merged_into_user_id IS NULL
    OR ROW(NEW.app_id, NEW.device_hash, NEW.user_id, NEW.register_method, NEW.created_at)
      IS DISTINCT FROM
      ROW(OLD.app_id, OLD.device_hash, OLD.user_id, OLD.register_method, OLD.created_at)
  THEN
    RAISE EXCEPTION 'device_registrations only permits setting an empty merge target once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.reject_device_registration_rewrite() FROM PUBLIC;

CREATE TRIGGER device_registrations_no_rewrite
  BEFORE UPDATE ON app.device_registrations
  FOR EACH ROW EXECUTE FUNCTION app.reject_device_registration_rewrite();

GRANT SELECT, INSERT, UPDATE, DELETE ON app.users, app.devices, app.user_oauth TO couli_app;
GRANT SELECT, INSERT ON app.login_logs TO couli_app;
GRANT SELECT ON app.device_registrations TO couli_app;
-- A new registration starts with no merge target; only the later one-time UPDATE can set it.
GRANT INSERT (app_id, device_hash, user_id, register_method, created_at)
  ON app.device_registrations TO couli_app;
GRANT UPDATE (merged_into_user_id) ON app.device_registrations TO couli_app;
GRANT SELECT ON app.users, app.devices, app.user_oauth, app.login_logs, app.device_registrations
  TO couli_readonly;
