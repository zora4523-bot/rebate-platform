-- Up Migration
-- Linking bindings (规划/04 §3.2 rows union_bindings, union_auth_sessions, links; BR-ID-17,
-- BR-ID-19, BR-ID-20, BR-ATTR-07; 拍板第二批 §8 ADD-01; SPEC_REF b9f54fe; ADR-0001 §4).
-- Compatibility: additive (two new tables, two new nullable links columns, one new trigger).
-- Recovery: restore from backup; no down migration.
-- Writer of all objects here: linking (规划/02 §4.1). Entity UUIDs are UUIDv7 supplied by
-- the application; business moments (bound_at, released_at, cooldown_until, expire_at,
-- used_at, promo_url_fetched_at) come from the injected Clock, never from SQL.
-- Depends on 0015 (union_accounts, B1-19a) and 0006 (links, devices (app_id, id) key).
--
-- union_bindings: status follows contracts/enums/identity.yaml union_binding_status (no
-- cooling; released + cooldown_until instead), blocked_reason follows
-- union_binding_blocked_reason. No activated_at (ADD-01: no self-service rebinding). External
-- identifiers (relation_id, special_id, pdd_custom) are text and NULL until authorization.
-- BR-ID-19 uniqueness as partial unique indexes:
--   (app_id, union_account_id, platform, relation_id) among status active / invalid / blocked;
--   (app_id, user_id, platform) among status pending_auth / active / invalid / blocked.
-- unbound and released rows occupy neither key. Cooldown is NOT enforced by the database:
-- the application treats status = released AND cooldown_until > now (injected Clock) as
-- cooling, and the cooldown length is configuration (bind.rebind_cooldown_days), so no SQL
-- interval is written here. The CHECKs only keep the release instants coherent: a released
-- row carries both instants, the two are set or cleared together (same-user restoration
-- clears both, BR-ID-19), and cooldown never ends before release. bound_at is written once
-- by the application and kept across invalid -> active and restoration (not a trigger rule,
-- because restoration legitimately rewrites the same row). Attribution uses the interval
-- [bound_at, COALESCE(cooldown_until, released_at)) regardless of current status
-- (BR-ATTR-07); relation lookups across all statuses use union_bindings_relation_idx.
-- union_account_id references union_accounts by (app_id, platform, id) so a binding's
-- platform always equals its station-owner account's platform and no cross-app reference is
-- possible. No columns for Taobao session tokens, credentials, nickname, avatar or account
-- name (BR-ID-17: tokens are used only in the filing call and never stored).
--
-- union_auth_sessions (renamed from auth_sessions to avoid confusion with login sessions):
-- state is the server-generated opaque value and the primary key, so it is unique across all
-- apps and stays reserved after use or expiry. mode only allows 'bind' (ADD-01 removed
-- rebind). link_id is NULL when started from "我的 -> 授权管理". The 10-minute validity and
-- single use (BR-ID-17, 30104) are application rules: the writer consumes with a single CAS
-- UPDATE ... SET used_at = :now WHERE state = :state AND used_at IS NULL AND expire_at > :now.
-- Storage backs this: couli_app may UPDATE only used_at, and a prohibitive trigger rejects
-- changing or clearing used_at once set, so a consumed state can never be made reusable.
-- The client is taken from the device record (device_id). The issued authorization method
-- (BR-ID-17 「授权方式」) has no column yet: 04 lists none; to be added with the bindings API.
--
-- links: our promotion link for the client-side Baichuan flow (docs/changes/
-- 20261003-淘宝转链改客户端百川.md §3 #6; the change record leaves the column names to this
-- migration, the orchestrator writes them back into 04 §3.2 links row):
--   promo_url             text         the promotion link obtained with this user's
--                                      relation_id and the scene's promotion slot;
--   promo_url_fetched_at  timestamptz  when that link was obtained.
-- Both are nullable (non-Taobao links and links before open never get one). Each may be filled
-- from NULL once (in either order, or at INSERT); afterwards it cannot change or be cleared
-- (prohibitive trigger, db/AGENTS.md #8, same pattern as the 0006 quote snapshot). Row locks
-- serialize concurrent fills: the loser re-reads the filled row and is rejected. couli_app
-- keeps its 0006 table-level SELECT / INSERT / UPDATE on links and has no DELETE, so a
-- delete/reinsert cannot bypass the guard. Validating user, relation_id and slot belongs to
-- linking's open/convert implementation, not to storage.
-- No foreign key cascades.

CREATE TABLE app.union_bindings (
  id               uuid NOT NULL,
  app_id           text NOT NULL,
  user_id          uuid NOT NULL,
  platform         text NOT NULL,
  union_account_id uuid NOT NULL,
  relation_id      text,
  special_id       text,
  pdd_custom       text,
  status           text NOT NULL,
  bound_at         timestamptz,
  released_at      timestamptz,
  cooldown_until   timestamptz,
  blocked_reason   text,
  reason           text,
  row_version      integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT union_bindings_pkey PRIMARY KEY (id),
  CONSTRAINT union_bindings_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT union_bindings_account_fkey FOREIGN KEY (app_id, platform, union_account_id)
    REFERENCES app.union_accounts (app_id, platform, id),
  CONSTRAINT union_bindings_status_check CHECK (
    status IN ('unbound', 'pending_auth', 'active', 'invalid', 'released', 'blocked')
  ),
  CONSTRAINT union_bindings_blocked_reason_check
    CHECK (blocked_reason IN ('ban', 'admin_disable', 'deletion')),
  CONSTRAINT union_bindings_release_pair_check
    CHECK ((released_at IS NULL) = (cooldown_until IS NULL)),
  CONSTRAINT union_bindings_released_instants_check
    CHECK (status <> 'released' OR released_at IS NOT NULL),
  CONSTRAINT union_bindings_cooldown_order_check CHECK (cooldown_until >= released_at)
);

CREATE UNIQUE INDEX union_bindings_relation_key
  ON app.union_bindings (app_id, union_account_id, platform, relation_id)
  WHERE status IN ('active', 'invalid', 'blocked');
CREATE UNIQUE INDEX union_bindings_user_platform_key
  ON app.union_bindings (app_id, user_id, platform)
  WHERE status IN ('pending_auth', 'active', 'invalid', 'blocked');
CREATE INDEX union_bindings_relation_idx
  ON app.union_bindings (app_id, platform, relation_id);
CREATE INDEX union_bindings_user_idx ON app.union_bindings (app_id, user_id);

CREATE TABLE app.union_auth_sessions (
  state      text NOT NULL,
  app_id     text NOT NULL,
  user_id    uuid NOT NULL,
  device_id  uuid NOT NULL,
  platform   text NOT NULL,
  mode       text NOT NULL,
  link_id    uuid,
  expire_at  timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT union_auth_sessions_pkey PRIMARY KEY (state),
  CONSTRAINT union_auth_sessions_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT union_auth_sessions_device_fkey FOREIGN KEY (app_id, device_id)
    REFERENCES app.devices (app_id, id),
  CONSTRAINT union_auth_sessions_link_fkey FOREIGN KEY (app_id, link_id)
    REFERENCES app.links (app_id, link_id),
  CONSTRAINT union_auth_sessions_mode_check CHECK (mode = 'bind')
);

CREATE INDEX union_auth_sessions_user_idx
  ON app.union_auth_sessions (app_id, user_id, created_at);

CREATE FUNCTION app.reject_union_auth_session_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF ROW(NEW.state, NEW.app_id, NEW.user_id, NEW.device_id, NEW.platform, NEW.mode,
         NEW.link_id, NEW.expire_at, NEW.created_at)
      IS DISTINCT FROM
      ROW(OLD.state, OLD.app_id, OLD.user_id, OLD.device_id, OLD.platform, OLD.mode,
          OLD.link_id, OLD.expire_at, OLD.created_at)
    OR (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
  THEN
    RAISE EXCEPTION 'union_auth_sessions are immutable and used_at is write-once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.reject_union_auth_session_rewrite() FROM PUBLIC;

CREATE TRIGGER union_auth_sessions_no_rewrite
  BEFORE UPDATE ON app.union_auth_sessions
  FOR EACH ROW EXECUTE FUNCTION app.reject_union_auth_session_rewrite();

ALTER TABLE app.links
  ADD COLUMN promo_url text,
  ADD COLUMN promo_url_fetched_at timestamptz;

CREATE FUNCTION app.reject_link_promo_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (OLD.promo_url IS NOT NULL AND NEW.promo_url IS DISTINCT FROM OLD.promo_url)
    OR (OLD.promo_url_fetched_at IS NOT NULL
      AND NEW.promo_url_fetched_at IS DISTINCT FROM OLD.promo_url_fetched_at)
  THEN
    RAISE EXCEPTION 'links promotion link is write-once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.reject_link_promo_rewrite() FROM PUBLIC;

CREATE TRIGGER links_no_promo_rewrite
  BEFORE UPDATE ON app.links
  FOR EACH ROW EXECUTE FUNCTION app.reject_link_promo_rewrite();

GRANT SELECT, INSERT, UPDATE ON app.union_bindings TO couli_app;
GRANT SELECT, INSERT ON app.union_auth_sessions TO couli_app;
GRANT UPDATE (used_at) ON app.union_auth_sessions TO couli_app;
GRANT SELECT ON app.union_bindings, app.union_auth_sessions TO couli_readonly;
