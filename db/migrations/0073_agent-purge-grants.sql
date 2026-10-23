-- Up Migration
-- Agent data purge on account deletion: column UPDATE grants and one-way redaction guards
-- (规划/08 BR-AI-22; orchestrator ruling D10-175 and its supplement; task B3-09f, after B1-15o /
-- 0070). Grants and guards only: no column, constraint or index changes, no data is moved.
-- Compatibility: couli_app gains column-level UPDATE on the free-text columns the purge clears;
-- every existing INSERT, SELECT and UPDATE stays valid. Five new BEFORE UPDATE triggers refuse
-- every rewrite except the one-way clearing below; app.reject_agent_run_rewrite() is replaced with
-- every 0021 / 0023 condition kept except that quota_subjects, final_event and end_draft admit one
-- exact one-way redaction each. No DELETE / TRUNCATE is granted: row skeletons stay until the
-- BR-ID-30 ① retention job removes them.
-- Recovery: restore from backup; no down migration.
--
-- Allowed rewrites (each is "unchanged" or "exactly the prescribed cleared value"; never a subset
-- test, so no other non-empty value can be written; every other column must stay unchanged):
--   agent_messages: unchanged (already has UPDATE(text, report_reason, report_note), no trigger).
--   agent_tool_calls.args: only to SQL NULL (also NULL → NULL); never '{}' or JSON null.
--   agent_cards.data: unchanged or '{}'; agent_cards.fallback_text: unchanged or the fixed
--     placeholder '内容已删除' (NOT NULL and the non-empty CHECK are kept, B3-09f §9 unknown 1).
--   agent_result_sets.conditions, agent_result_deliveries.card: unchanged or '{}'.
--   agent_result_chains.conditions: unchanged or exactly {"chain_id": <the row's chain_id>} (the
--     system-generated chain id, no user input; '{}' would break the existing CHECK). NULL is not a
--     cleared value, so a conditions value can never be dropped.
--   agent_runs.user_text: only to NULL (unchanged from 0021).
--   agent_runs.quota_subjects: unchanged, or the same number of elements with the same lower bound
--     where every position is either equal or turns a member tuple ["member","<canonical lowercase
--     uuid>"] into ["member","<64 lowercase hex>"] (the irreversible user hash; the hashing itself
--     belongs to the agent lane). Guest device / ip tuples, order and count never change; a hash is
--     never replaced or turned back.
--   agent_runs.final_event / end_draft (D10-175 supplement): once written, unchanged, or the same
--     envelope where only data.msg and data.fallback_q (the generated answer text and the
--     user-derived search keyword, contracts agent-stream.schema.json $defs/error) may become JSON
--     null. Both keys must already be present to be cleared; every other key and value (type,
--     code, retryable, fallback, finish_reason, quota_left, any other key) stays as it was.
-- Refusals raise restrict_violation (23001), as the existing agent guards do. Every condition is
-- written NULL-safe (CASE / COALESCE) so a NULL never lets a rewrite through.
--
-- Grants: column UPDATE for couli_app only, exactly on the columns above. couli_readonly,
-- couli_payout and couli_maint get nothing; existing column SELECT restrictions are unchanged.
-- None of these tables is a funds or attribution table.
--
-- Timeouts: CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock on each of the five tables and GRANT a
-- short catalog lock; no table is scanned. 5s lock wait so a blocked deploy fails fast instead of
-- queueing agent turns behind it, 30s overall as a ceiling for these catalog-only changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

GRANT UPDATE (args) ON app.agent_tool_calls TO couli_app;
GRANT UPDATE (data, fallback_text) ON app.agent_cards TO couli_app;
GRANT UPDATE (quota_subjects) ON app.agent_runs TO couli_app;
GRANT UPDATE (conditions) ON app.agent_result_sets TO couli_app;
GRANT UPDATE (card) ON app.agent_result_deliveries TO couli_app;
GRANT UPDATE (conditions) ON app.agent_result_chains TO couli_app;

-- agent_tool_calls: only args may change, and only to SQL NULL.
CREATE FUNCTION app.reject_agent_tool_call_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'args'::text) IS DISTINCT FROM (to_jsonb(OLD) - 'args'::text)
    OR NEW.args IS NOT NULL
  THEN
    RAISE EXCEPTION 'agent_tool_calls only permits clearing args to NULL'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.reject_agent_tool_call_rewrite() FROM PUBLIC;

CREATE TRIGGER agent_tool_calls_no_rewrite
  BEFORE UPDATE ON app.agent_tool_calls
  FOR EACH ROW EXECUTE FUNCTION app.reject_agent_tool_call_rewrite();

-- agent_cards: data only to '{}', fallback_text only to the fixed placeholder.
CREATE FUNCTION app.reject_agent_card_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'data'::text - 'fallback_text'::text)
      IS DISTINCT FROM (to_jsonb(OLD) - 'data'::text - 'fallback_text'::text)
    OR (NEW.data IS DISTINCT FROM OLD.data AND NEW.data IS DISTINCT FROM '{}'::jsonb)
    OR (NEW.fallback_text IS DISTINCT FROM OLD.fallback_text
        AND NEW.fallback_text IS DISTINCT FROM '内容已删除'::text)
  THEN
    RAISE EXCEPTION 'agent_cards only permits clearing data to {} and fallback_text to the placeholder'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.reject_agent_card_rewrite() FROM PUBLIC;

CREATE TRIGGER agent_cards_no_rewrite
  BEFORE UPDATE ON app.agent_cards
  FOR EACH ROW EXECUTE FUNCTION app.reject_agent_card_rewrite();

-- agent_result_sets: conditions only to '{}'.
CREATE FUNCTION app.reject_agent_result_set_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'conditions'::text) IS DISTINCT FROM (to_jsonb(OLD) - 'conditions'::text)
    OR (NEW.conditions IS DISTINCT FROM OLD.conditions
        AND NEW.conditions IS DISTINCT FROM '{}'::jsonb)
  THEN
    RAISE EXCEPTION 'agent_result_sets only permits clearing conditions to {}'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.reject_agent_result_set_rewrite() FROM PUBLIC;

CREATE TRIGGER agent_result_sets_no_rewrite
  BEFORE UPDATE ON app.agent_result_sets
  FOR EACH ROW EXECUTE FUNCTION app.reject_agent_result_set_rewrite();

-- agent_result_deliveries: card only to '{}'.
CREATE FUNCTION app.reject_agent_result_delivery_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'card'::text) IS DISTINCT FROM (to_jsonb(OLD) - 'card'::text)
    OR (NEW.card IS DISTINCT FROM OLD.card AND NEW.card IS DISTINCT FROM '{}'::jsonb)
  THEN
    RAISE EXCEPTION 'agent_result_deliveries only permits clearing card to {}'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.reject_agent_result_delivery_rewrite() FROM PUBLIC;

CREATE TRIGGER agent_result_deliveries_no_rewrite
  BEFORE UPDATE ON app.agent_result_deliveries
  FOR EACH ROW EXECUTE FUNCTION app.reject_agent_result_delivery_rewrite();

-- agent_result_chains: conditions only to {"chain_id": <this row's chain_id>}.
CREATE FUNCTION app.reject_agent_result_chain_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'conditions'::text) IS DISTINCT FROM (to_jsonb(OLD) - 'conditions'::text)
    OR (NEW.conditions IS DISTINCT FROM OLD.conditions
        AND NEW.conditions IS DISTINCT FROM jsonb_build_object('chain_id', OLD.chain_id))
  THEN
    RAISE EXCEPTION 'agent_result_chains only permits clearing conditions to its chain_id'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.reject_agent_result_chain_rewrite() FROM PUBLIC;

CREATE TRIGGER agent_result_chains_no_rewrite
  BEFORE UPDATE ON app.agent_result_chains
  FOR EACH ROW EXECUTE FUNCTION app.reject_agent_result_chain_rewrite();

-- agent_runs: same signature, owner and search_path as 0021 / 0023; the 0021 REVOKE from PUBLIC
-- still applies (CREATE OR REPLACE keeps the function's privileges) and the trigger
-- agent_runs_no_rewrite is unchanged. Every 0021 / 0023 condition is kept, except that
-- quota_subjects leaves the immutable ROW for its own per-position rule, and the write-once
-- final_event / end_draft conditions admit the msg / fallback_q redaction described above.
CREATE OR REPLACE FUNCTION app.reject_agent_run_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF ROW(NEW.id, NEW.app_id, NEW.session_id, NEW.prompt_version, NEW.accepted_at,
         NEW.created_at, NEW.deadline_at)
      IS DISTINCT FROM
      ROW(OLD.id, OLD.app_id, OLD.session_id, OLD.prompt_version, OLD.accepted_at,
          OLD.created_at, OLD.deadline_at)
    OR (NEW.quota_subjects IS DISTINCT FROM OLD.quota_subjects
        AND NOT COALESCE(
          array_ndims(NEW.quota_subjects) = 1
          AND cardinality(NEW.quota_subjects) = cardinality(OLD.quota_subjects)
          AND array_lower(NEW.quota_subjects, 1) = array_lower(OLD.quota_subjects, 1)
          AND NOT EXISTS (
            SELECT 1
            FROM unnest(OLD.quota_subjects, NEW.quota_subjects) AS s(old_subject, new_subject)
            WHERE old_subject IS DISTINCT FROM new_subject
              AND NOT COALESCE(
                old_subject ~ '^\["member","[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"\]$'
                AND new_subject ~ '^\["member","[0-9a-f]{64}"\]$',
                false)
          ),
          false))
    OR (OLD.final_event IS NOT NULL
        AND NEW.final_event IS DISTINCT FROM OLD.final_event
        AND NOT CASE
          WHEN jsonb_typeof(OLD.final_event) = 'object'
            AND jsonb_typeof(NEW.final_event) = 'object'
            AND jsonb_typeof(OLD.final_event -> 'data') = 'object'
            AND jsonb_typeof(NEW.final_event -> 'data') = 'object'
          THEN COALESCE(
            (NEW.final_event - 'data'::text) = (OLD.final_event - 'data'::text)
            AND ((NEW.final_event -> 'data') - 'msg'::text - 'fallback_q'::text)
              = ((OLD.final_event -> 'data') - 'msg'::text - 'fallback_q'::text)
            AND ((NEW.final_event -> 'data') ? 'msg'::text)
              = ((OLD.final_event -> 'data') ? 'msg'::text)
            AND ((NEW.final_event -> 'data') ? 'fallback_q'::text)
              = ((OLD.final_event -> 'data') ? 'fallback_q'::text)
            AND COALESCE(
              (NEW.final_event -> 'data' -> 'msg') = (OLD.final_event -> 'data' -> 'msg')
              OR (NEW.final_event -> 'data' -> 'msg') = 'null'::jsonb,
              true)
            AND COALESCE(
              (NEW.final_event -> 'data' -> 'fallback_q') = (OLD.final_event -> 'data' -> 'fallback_q')
              OR (NEW.final_event -> 'data' -> 'fallback_q') = 'null'::jsonb,
              true),
            false)
          ELSE false
        END)
    OR (OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at)
    OR (OLD.end_reason IS NOT NULL AND NEW.end_reason IS DISTINCT FROM OLD.end_reason)
    OR (OLD.settle_result IS NOT NULL AND NEW.settle_result IS DISTINCT FROM OLD.settle_result)
    OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at)
    OR (OLD.card_delivered AND NOT NEW.card_delivered)
    OR (OLD.settle_result IS NOT NULL AND NEW.card_delivered IS DISTINCT FROM OLD.card_delivered)
    OR (NEW.user_text IS NOT NULL AND NEW.user_text IS DISTINCT FROM OLD.user_text)
    OR (OLD.end_draft IS NOT NULL
        AND NEW.end_draft IS DISTINCT FROM OLD.end_draft
        AND NOT CASE
          WHEN jsonb_typeof(OLD.end_draft) = 'object'
            AND jsonb_typeof(NEW.end_draft) = 'object'
            AND jsonb_typeof(OLD.end_draft -> 'data') = 'object'
            AND jsonb_typeof(NEW.end_draft -> 'data') = 'object'
          THEN COALESCE(
            (NEW.end_draft - 'data'::text) = (OLD.end_draft - 'data'::text)
            AND ((NEW.end_draft -> 'data') - 'msg'::text - 'fallback_q'::text)
              = ((OLD.end_draft -> 'data') - 'msg'::text - 'fallback_q'::text)
            AND ((NEW.end_draft -> 'data') ? 'msg'::text)
              = ((OLD.end_draft -> 'data') ? 'msg'::text)
            AND ((NEW.end_draft -> 'data') ? 'fallback_q'::text)
              = ((OLD.end_draft -> 'data') ? 'fallback_q'::text)
            AND COALESCE(
              (NEW.end_draft -> 'data' -> 'msg') = (OLD.end_draft -> 'data' -> 'msg')
              OR (NEW.end_draft -> 'data' -> 'msg') = 'null'::jsonb,
              true)
            AND COALESCE(
              (NEW.end_draft -> 'data' -> 'fallback_q') = (OLD.end_draft -> 'data' -> 'fallback_q')
              OR (NEW.end_draft -> 'data' -> 'fallback_q') = 'null'::jsonb,
              true),
            false)
          ELSE false
        END)
    OR (OLD.cancel_requested_at IS NOT NULL
        AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at)
  THEN
    RAISE EXCEPTION 'agent_runs ending facts are write-once except text redaction, user_text may only be cleared and quota_subjects only hash a member'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
