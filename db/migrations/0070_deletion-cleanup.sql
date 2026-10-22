-- Up Migration
-- Storage for account-deletion cleanup (规划/08 BR-ID-27, BR-ID-28, BR-AI-22; orchestrator ruling
-- D10-137, task B1-15o §9.2). Task B1-15o, prerequisite of B1-15g (the cleanup itself) and of the
-- agent lane's purgeAgentDataForUser. Storage, grants and one guard change: no data is moved or
-- backfilled, no foreign key or existing column is dropped.
-- Compatibility: additive plus one relaxed NOT NULL. login_logs.user_id becomes nullable (every
-- existing row and writer stays valid); agent_sessions gets one nullable column without a default;
-- deletion_requests gets two nullable columns without defaults and one NOT NULL column with the
-- constant default 0 (no table rewrite on PostgreSQL 11+). Every INSERT that omits the new columns
-- stays valid. Existing constraints, indexes and grants are unchanged; the agent_sessions owner
-- guard app.reject_agent_session_rewrite() is replaced to admit the one-way detachment below
-- (orchestrator ruling D10-153), every other 0021 condition kept.
-- Recovery: restore from backup; no down migration.
--
-- app.login_logs.user_id: BR-ID-28 keeps login logs after deletion with the user association
-- removed, so the cleanup sets user_id to NULL. The tenant-qualified foreign key login_logs_user_fkey
-- (app_id, user_id) → users (app_id, id) stays as it is (NO ACTION, MATCH SIMPLE): a NULL user_id
-- is not checked, a non-NULL one still has to name a user of the same app.
--
-- app.agent_sessions.user_hash: the irreversible user hash BR-AI-22 keeps instead of the user
-- (lowercase hex SHA-256 style, 64 characters; the hashing itself belongs to the agent lane and is
-- not done here). NULL until the purge writes it. No index: the purge finds sessions by user_id.
--
-- app.agent_sessions detachment (D10-153): the purge clears user_id and writes user_hash in the same
-- UPDATE. user_id is already nullable (guest sessions, 0021), so no DROP NOT NULL is needed; the
-- foreign key agent_sessions_user_fkey stays (a NULL user_id is not checked). The owner guard
-- (trigger agent_sessions_no_rewrite, function app.reject_agent_session_rewrite) keeps every 0021
-- condition except that user_id may change in exactly one way: from non-NULL to NULL while the new
-- row carries a valid user_hash (64 lowercase hex characters). Any other user_id change
-- (reassignment, NULL alone, NULL with an invalid or missing hash) is refused with
-- restrict_violation, as is a card_seq decrease in the same statement. Once user_id is NULL (a
-- detached or guest session) user_hash is frozen, so a recorded hash is never rewritten and a guest
-- session never gains one. While user_id is still set, user_hash stays freely writable within its
-- CHECK. The trigger itself is unchanged (it still executes the same function).
--
-- app.deletion_requests cleanup progress (BR-ID-27, BR-ID-28):
--   cleaned_at: when the data cleanup finished (from the injected Clock; no SQL default). Independent
--     of processed_at / status; the identity service sets done.
--   apple_revoke_attempts: Apple token revocation attempts made, 0..3 (BR-ID-27: three retries,
--     then an alert, never blocking the deletion).
--   apple_revoke_result: revoked / failed / not_applicable, NULL while not yet decided.
--
-- Validation without NOT VALID: the CHECK constraints are on new columns that are NULL (or 0) on
-- every existing row, so the scan finds nothing; the runner uses one transaction, so NOT VALID +
-- VALIDATE would scan under the same lock and gain nothing (as in 0026, 0067). None of these tables
-- is a funds or attribution table.
--
-- Grants: column-level UPDATE for couli_app on exactly the columns the cleanup writes, added to the
-- existing column grants (0005, 0021, 0059); table-wide SELECT / INSERT for couli_app and SELECT for
-- couli_readonly already cover the new columns. No other role gets anything.
--
-- Timeouts: ALTER TABLE takes an ACCESS EXCLUSIVE lock on each of the three tables (DROP NOT NULL
-- and ADD COLUMN are catalog changes; the CHECK scans read small tables), held to commit; 5s lock
-- wait so a blocked deploy fails fast instead of queueing logins and agent turns behind it, 60s
-- overall as a ceiling for the three CHECK scans.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Relaxing NOT NULL is the point of this change (BR-ID-28: detached logs are kept). No existing
-- client breaks at the database level: every existing INSERT still supplies user_id, and the
-- regenerated db.gen.ts types it as nullable so readers are type-checked against NULL; detached
-- rows are written only by the B1-15g cleanup. login_logs is not a funds or attribution table.
-- squawk-ignore ban-drop-not-null
ALTER TABLE app.login_logs ALTER COLUMN user_id DROP NOT NULL;

GRANT UPDATE (user_id) ON app.login_logs TO couli_app;

ALTER TABLE app.agent_sessions ADD COLUMN user_hash text;

-- New column, NULL on every existing row: validating immediately is instant.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.agent_sessions ADD CONSTRAINT agent_sessions_user_hash_check CHECK (user_hash ~ '^[0-9a-f]{64}$');

-- Same signature, owner and search_path as 0021; the 0021 REVOKE from PUBLIC still applies (CREATE
-- OR REPLACE keeps the function's privileges). agent_sessions is not a funds or attribution table.
CREATE OR REPLACE FUNCTION app.reject_agent_session_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF ROW(NEW.id, NEW.app_id, NEW.device_id, NEW.started_at, NEW.created_at)
      IS DISTINCT FROM
      ROW(OLD.id, OLD.app_id, OLD.device_id, OLD.started_at, OLD.created_at)
    OR NEW.card_seq < OLD.card_seq
    OR (
      NEW.user_id IS DISTINCT FROM OLD.user_id
      AND NOT (
        OLD.user_id IS NOT NULL
        AND NEW.user_id IS NULL
        AND NEW.user_hash IS NOT NULL
        AND NEW.user_hash ~ '^[0-9a-f]{64}$'
      )
    )
    OR (OLD.user_id IS NULL AND NEW.user_hash IS DISTINCT FROM OLD.user_hash)
  THEN
    RAISE EXCEPTION 'agent_sessions owner is immutable except one-way detachment with a user hash, and card_seq never decreases'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

GRANT UPDATE (user_id, user_hash) ON app.agent_sessions TO couli_app;

ALTER TABLE app.deletion_requests
  ADD COLUMN cleaned_at timestamptz,
  ADD COLUMN apple_revoke_attempts smallint NOT NULL DEFAULT 0,
  ADD COLUMN apple_revoke_result text;

-- New columns, 0 / NULL on every existing row: validating immediately is instant.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.deletion_requests ADD CONSTRAINT deletion_requests_apple_revoke_attempts_check CHECK (apple_revoke_attempts BETWEEN 0 AND 3);

-- New column, NULL on every existing row: validating immediately is instant.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.deletion_requests ADD CONSTRAINT deletion_requests_apple_revoke_result_check CHECK (apple_revoke_result IN ('revoked', 'failed', 'not_applicable'));

GRANT UPDATE (cleaned_at, apple_revoke_attempts, apple_revoke_result)
  ON app.deletion_requests TO couli_app;
