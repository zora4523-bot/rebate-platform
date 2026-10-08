-- Up Migration
-- union_auth_sessions issuance metadata (规划/04 §3.2 row union_auth_sessions; BR-ID-17 细则
-- 「授权方式」; ADR-0001 §4). Writer: linking (B1-06g records at issuance, B1-06h checks before
-- consuming). After merge the planning session writes these columns back into 04 §3.2.
-- Compatibility: additive (three new columns with CHECKs, the 0018 prohibitive trigger function
-- extended to them; no grant changes). Recovery: restore from backup; no down migration.
--
-- Why: the state must record what was issued with it, so that bindings can verify before
-- consuming (device client equals the recorded client; the requested auth_method is in the
-- recorded list) and then exchange or use the credential with the recorded application. This
-- supersedes the 0018 header note that the issued authorization method "has no column yet".
--
-- Columns (all written once at INSERT, never changed afterwards):
--   client        text NOT NULL  the device client at issuance, taken by the writer from the
--                                devices record; only the native clients ios / android /
--                                harmony (contracts/enums/platform.yaml client_platform; union
--                                authorization only happens in the App, so h5 / admin are not
--                                accepted).
--   auth_methods  text[]         the ordered list issued for this state (configuration
--                                union.taobao.auth_methods.<client>). Required on Taobao rows
--                                and SQL NULL on every other platform (the Pinduoduo auth-url
--                                carries no auth_methods). When present: one-dimensional,
--                                1-based, at least one element, elements only web_code /
--                                sdk_token (contracts/enums/identity.yaml auth_method), no
--                                NULL elements, no duplicates.
--   auth_app_refs jsonb          per issued method, the identifier of the server-side
--                                application configuration used to exchange or use the
--                                credential (a version may be encoded in the identifier string).
--                                Identifiers only: never an app secret or any key material,
--                                and never an identifier reported by the client. Required
--                                exactly when auth_methods is present: a JSON object whose key
--                                set equals the issued methods and whose values are non-empty
--                                strings; SQL NULL otherwise (JSON null is rejected).
-- The CHECKs use only built-in operators (no helper function, no subquery): the auth_method
-- enum has two values, so distinctness is expressed by position; `refs - methods = '{}'`
-- together with `refs ?& methods` states key-set equality; the jsonb operators are guarded by
-- CASE so a scalar or array value fails the CHECK (23514) instead of raising an error. Adding a
-- new auth_method therefore needs a new migration, as the contract enum change would anyway.
--
-- Immutability: couli_app keeps its 0018 grants (SELECT, INSERT, column UPDATE (used_at) only),
-- so any UPDATE of the new columns is refused by privilege (42501). The 0018 trigger function
-- is replaced to add the three columns to its row comparison, so even a role with UPDATE cannot
-- rewrite them (restrict_violation); used_at stays fillable once and is write-once as before.
--
-- Existing rows: none are expected (the bindings API that writes this table is not released).
-- The migration refuses to run on a non-empty table instead of backfilling: the temporary
-- client default below would otherwise be written into existing rows, and Taobao rows would
-- fail the auth_methods CHECK. The default exists only so that adding a NOT NULL column passes
-- squawk's adding-required-field rule, and it is dropped in the same migration.
--
-- Timeouts: the table is empty (checked below), so the ACCESS EXCLUSIVE lock for ADD COLUMN and
-- the CHECK validation scan are instant; 5s lock wait so a blocked deploy fails fast instead of
-- queueing traffic behind it, 30s overall as a ceiling for these catalog-only statements.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.union_auth_sessions) THEN
    RAISE EXCEPTION 'app.union_auth_sessions is not empty: refusing to add issuance metadata without a backfill plan';
  END IF;
END
$$;

ALTER TABLE app.union_auth_sessions
  ADD COLUMN client text NOT NULL DEFAULT 'ios'
    CONSTRAINT union_auth_sessions_client_check
      CHECK (client IN ('ios', 'android', 'harmony')),
  ADD COLUMN auth_methods text[]
    CONSTRAINT union_auth_sessions_auth_methods_platform_check
      CHECK ((platform = 'taobao') = (auth_methods IS NOT NULL))
    CONSTRAINT union_auth_sessions_auth_methods_check
      CHECK (
        auth_methods IS NULL
        OR CASE
          WHEN array_ndims(auth_methods) = 1
            AND array_lower(auth_methods, 1) = 1
            AND array_position(auth_methods, NULL) IS NULL
            AND auth_methods <@ ARRAY['web_code', 'sdk_token']::text[]
          THEN cardinality(auth_methods) = 1
            OR (cardinality(auth_methods) = 2 AND auth_methods[1] <> auth_methods[2])
          ELSE false
        END
      ),
  ADD COLUMN auth_app_refs jsonb
    CONSTRAINT union_auth_sessions_auth_app_refs_presence_check
      CHECK ((auth_app_refs IS NULL) = (auth_methods IS NULL))
    CONSTRAINT union_auth_sessions_auth_app_refs_check
      CHECK (
        auth_app_refs IS NULL
        OR CASE
          WHEN auth_methods IS NOT NULL AND jsonb_typeof(auth_app_refs) = 'object'
          THEN auth_app_refs ?& auth_methods
            AND auth_app_refs - auth_methods = '{}'::jsonb
            AND (
              NOT auth_app_refs ? 'web_code'
              OR (jsonb_typeof(auth_app_refs -> 'web_code') = 'string'
                AND auth_app_refs ->> 'web_code' <> '')
            )
            AND (
              NOT auth_app_refs ? 'sdk_token'
              OR (jsonb_typeof(auth_app_refs -> 'sdk_token') = 'string'
                AND auth_app_refs ->> 'sdk_token' <> '')
            )
          ELSE false
        END
      );

ALTER TABLE app.union_auth_sessions ALTER COLUMN client DROP DEFAULT;

CREATE OR REPLACE FUNCTION app.reject_union_auth_session_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF ROW(NEW.state, NEW.app_id, NEW.user_id, NEW.device_id, NEW.platform, NEW.mode,
         NEW.link_id, NEW.expire_at, NEW.created_at, NEW.client, NEW.auth_methods,
         NEW.auth_app_refs)
      IS DISTINCT FROM
      ROW(OLD.state, OLD.app_id, OLD.user_id, OLD.device_id, OLD.platform, OLD.mode,
          OLD.link_id, OLD.expire_at, OLD.created_at, OLD.client, OLD.auth_methods,
          OLD.auth_app_refs)
    OR (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
  THEN
    RAISE EXCEPTION 'union_auth_sessions are immutable and used_at is write-once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.reject_union_auth_session_rewrite() FROM PUBLIC;
