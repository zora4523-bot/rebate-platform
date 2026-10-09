-- Up Migration
-- Agent acceptance, quota and run ending in PostgreSQL (owner decision 2026-10-08,
-- docs/changes/20261008-Agent受理与额度改用PG.md; BR-AI-23 细则「受理记录与收尾」, BR-AI-15;
-- B3-03g design §1.2; 规划/04 §3.2). Task B3-09b.
-- Compatibility: additive. New nullable columns without defaults (old writers that omit them stay
-- valid), CHECKs, three indexes, column grants, and app.reject_agent_run_rewrite() replaced with
-- every 0021 condition kept verbatim plus three new ones. reject_agent_session_rewrite is unchanged.
-- Recovery: restore from backup; no down migration.
--
-- agent_sessions.run_lock_run_id / run_lock_expires_at: the session-level run lock (BR-AI-23 ⑦).
-- Set by the acceptance transaction, cleared in the same transaction as the run's terminal event;
-- a later run takes the lock again, so these columns are not write-once. Both NULL or both set.
-- No foreign key to agent_runs: the lock is compared by value against the run id under the session
-- row lock, and the acceptance transaction writes the session before the run row.
--
-- agent_runs:
-- - deadline_at = accepted_at + run maximum duration, written at acceptance and never changed (no
--   UPDATE grant, and the rewrite trigger compares it with the other immutable columns). The cancel
--   endpoint refuses cancellations after it (BR-AI-23 细则「取消」).
-- - end_draft: the terminal frame chosen together with end_reason (same envelope as final_event);
--   written once, together with or after end_reason, never replaced or cleared.
-- - cancel_requested_at: the user's cancellation, written once with GREATEST(now, accepted_at) and
--   never replaced or cleared; whichever of it and end_reason commits first decides the ending.
-- - finalize_hold / finalize_hold_at: an open run whose automatic ending failed deterministically and
--   waits for manual handling. Not write-once (manual handling clears it), but a held run cannot
--   receive its terminal event and a terminal run cannot be held.
--
-- Indexes: daily usage and the minute window count runs per (app_id, quota subject, accepted_at);
-- quota_subjects[1] is the main subject, quota_subjects[2] the guest-tier IP key. The sweeper finds
-- expired session locks through agent_sessions_run_lock_idx.
--
-- Grants: couli_app may update the four mutable new agent_runs columns and the two lock columns;
-- deadline_at gets no UPDATE. couli_readonly reads every new column (agent_sessions already has a
-- table-level SELECT; agent_runs gets column SELECTs). couli_payout and couli_maint get nothing.
--
-- Validation without NOT VALID: the agent tables hold no production rows before the Agent launch
-- (M-内测), so each ADD CONSTRAINT scans an empty or tiny table under the lock it already holds.
--
-- Timeouts: ALTER TABLE takes ACCESS EXCLUSIVE locks on agent_sessions and agent_runs; 5s lock wait so
-- a blocked deploy fails fast instead of queueing traffic behind it, 30s overall as a ceiling for
-- catalog changes plus constraint scans and index builds on near-empty tables.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.agent_sessions
  ADD COLUMN run_lock_run_id uuid,
  ADD COLUMN run_lock_expires_at timestamptz;

-- No production rows before the Agent launch: validating immediately is instant.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.agent_sessions ADD CONSTRAINT agent_sessions_run_lock_pair_check CHECK ((run_lock_run_id IS NULL) = (run_lock_expires_at IS NULL));

ALTER TABLE app.agent_runs
  ADD COLUMN deadline_at timestamptz,
  ADD COLUMN end_draft jsonb,
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN finalize_hold text,
  ADD COLUMN finalize_hold_at timestamptz;

-- No production rows before the Agent launch: validating immediately is instant.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.agent_runs ADD CONSTRAINT agent_runs_deadline_order_check CHECK (deadline_at >= accepted_at);

-- The cancel endpoint writes GREATEST(now, accepted_at) in the same UPDATE (design §5.2).
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.agent_runs ADD CONSTRAINT agent_runs_cancel_order_check CHECK (cancel_requested_at >= accepted_at);

-- end_draft is exactly {"type": "done" | "error", "data": {…}}, the same shape as final_event
-- (0021 agent_runs_final_event_check); CASE keeps the jsonb operators away from scalars and arrays
-- so a malformed value fails with 23514.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.agent_runs ADD CONSTRAINT agent_runs_end_draft_check CHECK (
  end_draft IS NULL OR COALESCE(CASE
    WHEN jsonb_typeof(end_draft) = 'object' THEN
      end_draft ?& ARRAY['type', 'data']
      AND (end_draft - 'type' - 'data') = '{}'::jsonb
      AND jsonb_typeof(end_draft -> 'type') = 'string'
      AND (end_draft ->> 'type') IN ('done', 'error')
      AND jsonb_typeof(end_draft -> 'data') = 'object'
    ELSE false
  END, false)
);

-- The draft frame is chosen together with the ending reason, never before it.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.agent_runs ADD CONSTRAINT agent_runs_end_draft_reason_check CHECK (end_draft IS NULL OR end_reason IS NOT NULL);

-- Manual-handling reasons of the run ending (design §3.5).
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.agent_runs ADD CONSTRAINT agent_runs_finalize_hold_check CHECK (finalize_hold IN ('stored_frame_invalid', 'facts_inconsistent'));

-- The hold and its moment are set and cleared together.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.agent_runs ADD CONSTRAINT agent_runs_finalize_hold_pair_check CHECK ((finalize_hold IS NULL) = (finalize_hold_at IS NULL));

-- Only an open run can be held, and a held run cannot receive its terminal event.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.agent_runs ADD CONSTRAINT agent_runs_finalize_hold_open_check CHECK (finalize_hold IS NULL OR final_event IS NULL);

-- BR-AI-23 ⑧ minute window and ⑩ daily usage of the main subject.
CREATE INDEX agent_runs_quota_first_idx
  ON app.agent_runs (app_id, (quota_subjects[1]), accepted_at);
-- BR-AI-23 ⑩ daily usage of the guest-tier IP key.
CREATE INDEX agent_runs_quota_second_idx
  ON app.agent_runs (app_id, (quota_subjects[2]), accepted_at)
  WHERE cardinality(quota_subjects) = 2;
-- The sweeper's scan for expired session locks.
CREATE INDEX agent_sessions_run_lock_idx
  ON app.agent_sessions (run_lock_expires_at, id)
  WHERE run_lock_run_id IS NOT NULL;

-- Prohibitive trigger only (db/AGENTS.md rule 8), raising restrict_violation (23001). Every 0021
-- condition is kept verbatim; added: deadline_at joins the immutable columns, end_draft and
-- cancel_requested_at may each be written once from NULL and never replaced or cleared. Owner,
-- privileges, search_path and the trigger agent_runs_no_rewrite are unchanged.
CREATE OR REPLACE FUNCTION app.reject_agent_run_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF ROW(NEW.id, NEW.app_id, NEW.session_id, NEW.prompt_version, NEW.accepted_at,
         NEW.quota_subjects, NEW.created_at, NEW.deadline_at)
      IS DISTINCT FROM
      ROW(OLD.id, OLD.app_id, OLD.session_id, OLD.prompt_version, OLD.accepted_at,
          OLD.quota_subjects, OLD.created_at, OLD.deadline_at)
    OR (OLD.final_event IS NOT NULL AND NEW.final_event IS DISTINCT FROM OLD.final_event)
    OR (OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at)
    OR (OLD.end_reason IS NOT NULL AND NEW.end_reason IS DISTINCT FROM OLD.end_reason)
    OR (OLD.settle_result IS NOT NULL AND NEW.settle_result IS DISTINCT FROM OLD.settle_result)
    OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at)
    OR (OLD.card_delivered AND NOT NEW.card_delivered)
    OR (OLD.settle_result IS NOT NULL AND NEW.card_delivered IS DISTINCT FROM OLD.card_delivered)
    OR (NEW.user_text IS NOT NULL AND NEW.user_text IS DISTINCT FROM OLD.user_text)
    OR (OLD.end_draft IS NOT NULL AND NEW.end_draft IS DISTINCT FROM OLD.end_draft)
    OR (OLD.cancel_requested_at IS NOT NULL
        AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at)
  THEN
    RAISE EXCEPTION 'agent_runs ending facts are write-once and user_text may only be cleared'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

GRANT UPDATE (run_lock_run_id, run_lock_expires_at) ON app.agent_sessions TO couli_app;
GRANT UPDATE (end_draft, cancel_requested_at, finalize_hold, finalize_hold_at)
  ON app.agent_runs TO couli_app;
GRANT SELECT (deadline_at, end_draft, cancel_requested_at, finalize_hold, finalize_hold_at)
  ON app.agent_runs TO couli_readonly;
