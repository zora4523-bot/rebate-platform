-- Up Migration
-- Linking baseline (规划/04 §3.2; ADR-0001 §4).
-- Compatibility: additive. Recovery: restore from backup; no down migration.
-- UUIDs (including link_id and attempt_id) are UUIDv7 supplied by the application.
-- External identifiers are text; convert_result holds encrypted bytes, never plaintext.
-- Unspecified business vocabularies remain text; link_logs.event follows contracts/enums/trade.yaml.
-- apps, platform and Agent entity foreign keys await their respective baseline tables.
-- User, device and link references include app_id to prevent cross-app associations.
-- Exception: link_logs must record failed open/convert requests (BR-ATTR-14), including
-- unknown/cross-app link IDs and missing fields. Its link_id has no FK; link_id, platform
-- and scene are nullable so failures 30144, 30131 and 20001 can still be logged.
-- A supporting device index supplies the composite foreign-key target without changing 0005.
--
-- Prohibitive UPDATE guards only (db/AGENTS.md #8): no business writes or SQL clock reads.
-- Quote fields may be filled from NULL, but a non-NULL value cannot change or be cleared.
-- Once quoted_at is set, the entire snapshot is frozen, including absent coupon values.
-- This permits registration before a quote while preserving the quote shown to the user.
-- Attempt identity is immutable; each report/dismissal timestamp can be filled independently
-- once. Row locks serialize competing updates, so a later writer cannot overwrite the first.
-- couli_app has no DELETE on these tables, preventing delete/reinsert from bypassing guards;
-- retention maintenance belongs to a later task, not to request handlers.
--
-- CAS (ADR-0001 §4.1, as in 0005): links and link_open_attempts start row_version at 0.
-- Writers compare the previous version and increment it in the same UPDATE; triggers do
-- not increment versions or perform state transitions. link_logs is append-only, no version.
-- Logs are partitioned BY DAY, despite the task title. Only DEFAULT is created here;
-- daily partition creation/deletion is a later maintenance task. ensure_month_partition
-- and packages/db/src/partitions.ts deliberately remain unchanged. No link_log_evidence yet.

CREATE UNIQUE INDEX devices_app_id_id_key ON app.devices (app_id, id);

CREATE TABLE app.links (
  link_id                uuid NOT NULL,
  app_id                 text NOT NULL,
  user_id                uuid,
  device_id              uuid,
  platform               text NOT NULL,
  product_key            text,
  raw_item_id            text,
  raw_fetched_at         timestamptz,
  scene                  text NOT NULL,
  sub_scene              text,
  pid_scene              text,
  pid                    text,
  entry_source           text,
  identity_snapshot      jsonb,
  convert_result         bytea,
  cache_hit              boolean NOT NULL DEFAULT false,
  quoted_final_price_fen bigint,
  quoted_coupon_fen      bigint,
  quoted_coupon_id       text,
  quoted_at              timestamptz,
  expire_at              timestamptz NOT NULL,
  agent_session_id       uuid,
  agent_card_id          text,
  row_version            integer NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT links_pkey PRIMARY KEY (link_id),
  CONSTRAINT links_app_id_link_id_key UNIQUE (app_id, link_id),
  CONSTRAINT links_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT links_device_fkey FOREIGN KEY (app_id, device_id)
    REFERENCES app.devices (app_id, id)
);

CREATE FUNCTION app.reject_link_quote_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF ROW(NEW.app_id, NEW.link_id) IS DISTINCT FROM ROW(OLD.app_id, OLD.link_id)
    OR (OLD.quoted_final_price_fen IS NOT NULL
      AND NEW.quoted_final_price_fen IS DISTINCT FROM OLD.quoted_final_price_fen)
    OR (OLD.quoted_coupon_fen IS NOT NULL
      AND NEW.quoted_coupon_fen IS DISTINCT FROM OLD.quoted_coupon_fen)
    OR (OLD.quoted_coupon_id IS NOT NULL
      AND NEW.quoted_coupon_id IS DISTINCT FROM OLD.quoted_coupon_id)
    OR (OLD.quoted_at IS NOT NULL
      AND ROW(NEW.quoted_final_price_fen, NEW.quoted_coupon_fen, NEW.quoted_coupon_id, NEW.quoted_at)
        IS DISTINCT FROM
        ROW(OLD.quoted_final_price_fen, OLD.quoted_coupon_fen, OLD.quoted_coupon_id, OLD.quoted_at))
  THEN
    RAISE EXCEPTION 'links identity and written quote snapshot are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.reject_link_quote_rewrite() FROM PUBLIC;

CREATE TRIGGER links_no_quote_rewrite
  BEFORE UPDATE ON app.links
  FOR EACH ROW EXECUTE FUNCTION app.reject_link_quote_rewrite();

CREATE TABLE app.link_logs (
  id               bigint GENERATED ALWAYS AS IDENTITY,
  app_id           text NOT NULL,
  link_id          uuid,
  event            text NOT NULL,
  user_id          uuid,
  opener_user_id   uuid,
  platform         text,
  product_key      text,
  raw_item_id      text,
  shop_id          text,
  scene            text,
  pid_scene        text,
  spm              text,
  pid              text,
  relation_id      text,
  client           text,
  cache_hit        boolean NOT NULL DEFAULT false,
  expired          boolean NOT NULL DEFAULT false,
  quoted_price_fen bigint,
  no_rebate        boolean NOT NULL DEFAULT false,
  no_rebate_reason text,
  agent_session_id uuid,
  agent_message_id uuid,
  prompt_version   text,
  model            text,
  result_code      integer NOT NULL,
  latency_ms       integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT link_logs_pkey PRIMARY KEY (id, created_at),
  CONSTRAINT link_logs_event_check CHECK (event IN ('convert', 'precompute', 'register', 'open')),
  CONSTRAINT link_logs_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT link_logs_opener_user_fkey FOREIGN KEY (app_id, opener_user_id)
    REFERENCES app.users (app_id, id)
) PARTITION BY RANGE (created_at);

CREATE TABLE app.link_logs_default PARTITION OF app.link_logs DEFAULT;

CREATE INDEX link_logs_link_created_idx ON app.link_logs (app_id, link_id, created_at);

CREATE TRIGGER link_logs_append_only
  BEFORE UPDATE OR DELETE ON app.link_logs
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

CREATE TABLE app.link_open_attempts (
  attempt_id       uuid NOT NULL,
  app_id           text NOT NULL,
  link_id          uuid NOT NULL,
  user_id          uuid,
  opened_at        timestamptz NOT NULL,
  jump_reported_at timestamptz,
  dismissed_at     timestamptz,
  row_version      integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT link_open_attempts_pkey PRIMARY KEY (attempt_id),
  CONSTRAINT link_open_attempts_link_fkey FOREIGN KEY (app_id, link_id)
    REFERENCES app.links (app_id, link_id),
  CONSTRAINT link_open_attempts_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id)
);

CREATE INDEX link_open_attempts_user_opened_idx
  ON app.link_open_attempts (app_id, user_id, opened_at);
CREATE INDEX link_open_attempts_link_idx ON app.link_open_attempts (app_id, link_id);

CREATE FUNCTION app.reject_link_open_attempt_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF ROW(NEW.attempt_id, NEW.app_id, NEW.link_id, NEW.user_id, NEW.opened_at)
      IS DISTINCT FROM
      ROW(OLD.attempt_id, OLD.app_id, OLD.link_id, OLD.user_id, OLD.opened_at)
    OR (OLD.jump_reported_at IS NOT NULL
      AND NEW.jump_reported_at IS DISTINCT FROM OLD.jump_reported_at)
    OR (OLD.dismissed_at IS NOT NULL
      AND NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at)
  THEN
    RAISE EXCEPTION 'link_open_attempts identity is immutable and timestamps are write-once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.reject_link_open_attempt_rewrite() FROM PUBLIC;

CREATE TRIGGER link_open_attempts_no_rewrite
  BEFORE UPDATE ON app.link_open_attempts
  FOR EACH ROW EXECUTE FUNCTION app.reject_link_open_attempt_rewrite();

GRANT SELECT, INSERT, UPDATE ON app.links TO couli_app;
GRANT SELECT, INSERT ON app.link_logs, app.link_open_attempts TO couli_app;
GRANT UPDATE (jump_reported_at, dismissed_at, row_version, updated_at)
  ON app.link_open_attempts TO couli_app;
GRANT SELECT ON app.links, app.link_logs, app.link_logs_default, app.link_open_attempts
  TO couli_readonly;
