-- Up Migration
-- Agent tables (规划/04 §3.1 relation diagram, §3.2 rows agent_sessions, agent_runs,
-- agent_messages, agent_tool_calls, agent_result_sets / agent_cards; §8.1 duplicate messages,
-- §8.2 / §8.3 card_id; BR-AI-19, BR-AI-23 细则「受理记录与收尾」, BR-AI-06, BR-AI-16, BR-AI-20,
-- BR-AI-22, BR-ID-30 ①; SPEC_REF 4070ad5; ADR-0001 §4). Task B3-09a.
-- Compatibility: additive (six new tables, two prohibitive triggers; no existing table changes).
-- Recovery: restore from backup; no down migration.
-- Writer of all objects here: agent (规划/02 §4.1). Entity UUIDs are UUIDv7 supplied by the
-- application (no id defaults); every business moment (started_at, last_active_at, expired_at,
-- accepted_at, ended_at, settled_at, feedback_at, reported_at, report_handled_at) comes from the
-- injected Clock. Only created_at / updated_at default to now(). Foreign keys are NO ACTION.
--
-- Not partitioned: ADR-0001 §4.2 item 5 does not list agent tables, and partitioning would force
-- the partition key into (app_id, session_id, client_msg_id) and into the foreign-key targets.
-- Retention (BR-ID-30 ①) deletes by created_at through the (app_id, created_at) indexes.
--
-- Columns marked [S] in the plan (couli-runs/B3-09a-06a/plan.md §1.4) were confirmed by the
-- B3-03 line on 2026-10-06: agent_runs.accepted_at, quota_subjects, end_reason, card_delivered,
-- settle_result, settled_at and the write-once rules; prompt_version NOT NULL;
-- agent_sessions.card_seq; agent_messages (run_id, role) unique. agent_cards.schema_version and
-- fallback_text come from orchestrator decision D2 (CT-08e history API). 04 §3.2 omits
-- agent_runs.output_truncated (BR-AI-06) and price_version (BR-AI-16); they are created here and
-- written back to 04 by the planning session.
--
-- agent_sessions: owner is user_id when non-NULL, otherwise device_id (BR-AI-20); 04's single
-- "user_id (guest: device_id)" column is split so both can carry foreign keys. expired_at only
-- has to be later than last_active_at (both "expiry moment" and "moment found expired" satisfy
-- it); the 24-hour rule stays in the application. card_seq is the largest card number handed
-- out: CardSequence.reserve is `UPDATE … SET card_seq = card_seq + n RETURNING card_seq - n + 1`
-- under the row lock, and a trigger rejects any decrease (card numbers are never reused).
--
-- agent_runs: accepted_at, quota_subjects and prompt_version are written at acceptance and never
-- change (no UPDATE grant). quota_subjects are the opaque counting subjects passed to the
-- acceptance script; the writer stores the ipKey it was given, never a plain IP. end_reason has
-- no CHECK: its vocabulary follows B3-03c RunEnding and has no contract enum yet (0006 precedent
-- for open vocabularies). Ending facts final_event, ended_at, end_reason, settle_result and
-- settled_at may each be written once from NULL and are never replaced or cleared afterwards,
-- whether or not final_event exists yet (crash recovery must not rewrite them). card_delivered
-- only moves false -> true and is frozen once settled. The CHECKs require an end_reason before
-- settlement and settlement before the terminal event (BR-AI-23). user_text is written only at
-- INSERT and may afterwards only be cleared, so a late asynchronous trace retry cannot refill it
-- after account-deletion cleanup (BR-AI-22). Trace columns stay updatable after the end.
--
-- agent_messages: the user row and the assistant row of a run are both written at acceptance
-- (D2); text and card_ids of the assistant row are filled by the asynchronous trace. A user row
-- needs client_msg_id and run_id; an assistant row never has client_msg_id; feedback and reports
-- only exist on assistant rows. (app_id, session_id, client_msg_id) deduplicates retries;
-- (app_id, run_id, role) lets a duplicate message find the original reply's message_id.
--
-- agent_cards: one row per frame card. earnings_summary rows keep only as_of and actions, never
-- amounts (BR-AI-19 细则, D32). The mapping of embedded product cards to links lives in
-- links.agent_card_id.
--
-- No foreign keys from links, orders or link_logs into agent_* (closing the 0006 "pending
-- baseline" note): agent rows are deleted after the retention period while links and orders are
-- kept (BR-ID-30 ⑰), and link_logs is partitioned.
--
-- Grants: couli_app gets SELECT, INSERT and only the column UPDATEs it needs; agent_tool_calls,
-- agent_result_sets and agent_cards are append-only (no UPDATE). No DELETE or TRUNCATE for any
-- business role: the 03:00 retention job (BR-ID-30 ①) and deletion cleanup (BR-AI-22) belong to a
-- later task. couli_readonly may not read user free text (user_text, message text, report_reason,
-- tool args, result-set conditions): viewing traces goes through the agent-traces permission with
-- audit (BR-AI-19). couli_payout and couli_maint get nothing.
--
-- Timeouts: only new tables are created, but the foreign keys take SHARE ROW EXCLUSIVE locks on
-- users, devices, links and admin_users; 5s lock wait so a blocked deploy fails fast instead of
-- queueing traffic behind it, 30s overall as a ceiling for these catalog-only statements.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.agent_sessions (
  id             uuid NOT NULL,
  app_id         text NOT NULL,
  user_id        uuid,
  device_id      uuid NOT NULL,
  started_at     timestamptz NOT NULL,
  last_active_at timestamptz NOT NULL,
  expired_at     timestamptz,
  card_seq       integer NOT NULL DEFAULT 0,
  row_version    integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT agent_sessions_app_id_id_key UNIQUE (app_id, id),
  CONSTRAINT agent_sessions_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT agent_sessions_device_fkey FOREIGN KEY (app_id, device_id)
    REFERENCES app.devices (app_id, id),
  CONSTRAINT agent_sessions_active_order_check CHECK (last_active_at >= started_at),
  CONSTRAINT agent_sessions_expired_order_check CHECK (expired_at > last_active_at),
  CONSTRAINT agent_sessions_card_seq_check CHECK (card_seq >= 0)
);

CREATE INDEX agent_sessions_user_recent_idx
  ON app.agent_sessions (app_id, user_id, last_active_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX agent_sessions_guest_recent_idx
  ON app.agent_sessions (app_id, device_id, last_active_at DESC) WHERE user_id IS NULL;
CREATE INDEX agent_sessions_created_idx ON app.agent_sessions (app_id, created_at);

CREATE TABLE app.agent_runs (
  id                       uuid NOT NULL,
  app_id                   text NOT NULL,
  session_id               uuid NOT NULL,
  user_text                text,
  intent                   text,
  model                    text,
  model_snapshot           text,
  prompt_version           text NOT NULL,
  input_tokens             integer,
  output_tokens            integer,
  cost_mfen                bigint,
  ttft_ms                  integer,
  latency_ms               integer,
  finish_reason            text,
  final_event              jsonb,
  ended_at                 timestamptz,
  output_filtered          boolean NOT NULL DEFAULT false,
  filter_hits              text[] NOT NULL DEFAULT '{}',
  output_truncated         boolean NOT NULL DEFAULT false,
  price_version            text,
  result_check_provider    text,
  judge_model              text,
  page_guide_reject_reason text,
  accepted_at              timestamptz NOT NULL,
  quota_subjects           text[] NOT NULL,
  end_reason               text,
  card_delivered           boolean NOT NULL DEFAULT false,
  settle_result            text,
  settled_at               timestamptz,
  row_version              integer NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_runs_pkey PRIMARY KEY (id),
  CONSTRAINT agent_runs_app_id_id_key UNIQUE (app_id, id),
  CONSTRAINT agent_runs_app_id_session_id_id_key UNIQUE (app_id, session_id, id),
  CONSTRAINT agent_runs_session_fkey FOREIGN KEY (app_id, session_id)
    REFERENCES app.agent_sessions (app_id, id),
  -- contracts/enums/ops.yaml agent_intent
  CONSTRAINT agent_runs_intent_check CHECK (intent IN (
    'find_by_link', 'search', 'refine', 'order_query', 'rule_qa', 'handoff', 'clarify',
    'out_of_scope', 'page_guide', 'earnings_query'
  )),
  -- contracts/enums/ops.yaml agent_finish_reason
  CONSTRAINT agent_runs_finish_reason_check CHECK (finish_reason IN (
    'stop', 'cancelled', 'limit', 'budget', 'error', 'auth_required', 'safety', 'fallback',
    'timeout'
  )),
  -- contracts/enums/ops.yaml page_guide_reject_reason
  CONSTRAINT agent_runs_page_guide_reject_reason_check CHECK (page_guide_reject_reason IN (
    'not_allowed', 'extra_fields', 'disabled', 'untrusted_input', 'params_requested'
  )),
  CONSTRAINT agent_runs_result_check_provider_check
    CHECK (result_check_provider IN ('rules', 'jev')),
  CONSTRAINT agent_runs_settle_result_check CHECK (settle_result IN ('counted', 'refunded')),
  CONSTRAINT agent_runs_counts_check CHECK (
    input_tokens >= 0 AND output_tokens >= 0 AND cost_mfen >= 0
    AND ttft_ms >= 0 AND latency_ms >= 0
  ),
  -- final_event is exactly {"type": "done" | "error", "data": {…}}; CASE keeps the jsonb
  -- operators away from scalars and arrays so a malformed value fails with 23514.
  CONSTRAINT agent_runs_final_event_check CHECK (
    final_event IS NULL OR COALESCE(CASE
      WHEN jsonb_typeof(final_event) = 'object' THEN
        final_event ?& ARRAY['type', 'data']
        AND (final_event - 'type' - 'data') = '{}'::jsonb
        AND jsonb_typeof(final_event -> 'type') = 'string'
        AND (final_event ->> 'type') IN ('done', 'error')
        AND jsonb_typeof(final_event -> 'data') = 'object'
      ELSE false
    END, false)
  ),
  CONSTRAINT agent_runs_final_pair_check CHECK ((final_event IS NULL) = (ended_at IS NULL)),
  CONSTRAINT agent_runs_final_after_settle_check
    CHECK (final_event IS NULL OR settle_result IS NOT NULL),
  CONSTRAINT agent_runs_settle_pair_check CHECK ((settle_result IS NULL) = (settled_at IS NULL)),
  CONSTRAINT agent_runs_settle_after_end_check
    CHECK (settle_result IS NULL OR end_reason IS NOT NULL),
  CONSTRAINT agent_runs_ended_order_check CHECK (ended_at >= accepted_at),
  CONSTRAINT agent_runs_filter_hits_check CHECK (
    CASE
      WHEN cardinality(filter_hits) = 0 THEN true
      WHEN array_ndims(filter_hits) = 1 THEN
        CASE
          WHEN array_position(filter_hits, NULL) IS NULL
            THEN filter_hits <@ ARRAY['amount', 'url', 'tpwd']::text[]
          ELSE false
        END
      ELSE false
    END
  ),
  CONSTRAINT agent_runs_output_filtered_check
    CHECK (output_filtered = (cardinality(filter_hits) > 0)),
  CONSTRAINT agent_runs_quota_subjects_check CHECK (
    CASE
      WHEN array_ndims(quota_subjects) = 1 THEN
        CASE
          WHEN array_position(quota_subjects, NULL) IS NULL
            THEN cardinality(quota_subjects) BETWEEN 1 AND 2
          ELSE false
        END
      ELSE false
    END
  )
);

CREATE INDEX agent_runs_session_accepted_idx
  ON app.agent_runs (app_id, session_id, accepted_at);
CREATE INDEX agent_runs_session_unfinished_idx
  ON app.agent_runs (app_id, session_id) WHERE final_event IS NULL;
CREATE INDEX agent_runs_created_idx ON app.agent_runs (app_id, created_at);

CREATE TABLE app.agent_messages (
  id                uuid NOT NULL,
  app_id            text NOT NULL,
  session_id        uuid NOT NULL,
  run_id            uuid,
  client_msg_id     text,
  role              text NOT NULL,
  text              text,
  card_ids          text[] NOT NULL DEFAULT '{}',
  feedback          text,
  feedback_at       timestamptz,
  reported          boolean NOT NULL DEFAULT false,
  report_reason     text,
  reported_at       timestamptz,
  report_status     text,
  report_handler_id uuid,
  report_handled_at timestamptz,
  report_note       text,
  badcase           boolean NOT NULL DEFAULT false,
  row_version       integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_messages_pkey PRIMARY KEY (id),
  CONSTRAINT agent_messages_client_msg_key UNIQUE (app_id, session_id, client_msg_id),
  CONSTRAINT agent_messages_session_fkey FOREIGN KEY (app_id, session_id)
    REFERENCES app.agent_sessions (app_id, id),
  -- MATCH SIMPLE: a message without a run is not checked against agent_runs.
  CONSTRAINT agent_messages_run_fkey FOREIGN KEY (app_id, session_id, run_id)
    REFERENCES app.agent_runs (app_id, session_id, id),
  CONSTRAINT agent_messages_report_handler_fkey FOREIGN KEY (app_id, report_handler_id)
    REFERENCES app.admin_users (app_id, id),
  CONSTRAINT agent_messages_role_check CHECK (role IN ('user', 'assistant')),
  CONSTRAINT agent_messages_user_keys_check
    CHECK (role <> 'user' OR (client_msg_id IS NOT NULL AND run_id IS NOT NULL)),
  CONSTRAINT agent_messages_assistant_client_check
    CHECK (role <> 'assistant' OR client_msg_id IS NULL),
  CONSTRAINT agent_messages_user_no_feedback_check CHECK (
    role <> 'user' OR (feedback IS NULL AND feedback_at IS NULL AND NOT reported)
  ),
  CONSTRAINT agent_messages_feedback_check CHECK (feedback IN ('up', 'down')),
  CONSTRAINT agent_messages_feedback_pair_check
    CHECK ((feedback IS NULL) = (feedback_at IS NULL)),
  CONSTRAINT agent_messages_down_badcase_check
    CHECK (feedback IS DISTINCT FROM 'down' OR badcase),
  CONSTRAINT agent_messages_reported_pair_check CHECK (reported = (reported_at IS NOT NULL)),
  CONSTRAINT agent_messages_report_status_check
    CHECK (report_status IN ('pending', 'handled')),
  CONSTRAINT agent_messages_report_status_pair_check
    CHECK (reported = (report_status IS NOT NULL)),
  CONSTRAINT agent_messages_report_handled_check CHECK (
    (report_status IS NOT DISTINCT FROM 'handled') = (report_handled_at IS NOT NULL)
    AND (report_status IS NOT DISTINCT FROM 'handled') = (report_handler_id IS NOT NULL)
  ),
  -- Every element matches ^c[1-9][0-9]*$ (04 §8.3 card_id); valid elements contain no comma,
  -- so the joined string matches and re-splits into exactly cardinality elements.
  CONSTRAINT agent_messages_card_ids_check CHECK (
    CASE
      WHEN cardinality(card_ids) = 0 THEN true
      WHEN array_ndims(card_ids) = 1 THEN
        CASE
          WHEN array_position(card_ids, NULL) IS NULL THEN
            array_to_string(card_ids, ',') ~ '^c[1-9][0-9]*(,c[1-9][0-9]*)*$'
            AND cardinality(string_to_array(array_to_string(card_ids, ','), ','))
              = cardinality(card_ids)
          ELSE false
        END
      ELSE false
    END
  )
);

CREATE UNIQUE INDEX agent_messages_run_role_key
  ON app.agent_messages (app_id, run_id, role) WHERE run_id IS NOT NULL;
CREATE INDEX agent_messages_session_created_idx
  ON app.agent_messages (app_id, session_id, created_at);
CREATE INDEX agent_messages_reported_idx
  ON app.agent_messages (app_id, report_status, reported_at) WHERE reported;
CREATE INDEX agent_messages_created_idx ON app.agent_messages (app_id, created_at);

CREATE TABLE app.agent_tool_calls (
  id            uuid NOT NULL,
  app_id        text NOT NULL,
  run_id        uuid NOT NULL,
  seq           integer NOT NULL,
  name          text NOT NULL,
  args          jsonb,
  result_digest text,
  status        text NOT NULL,
  latency_ms    integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_tool_calls_pkey PRIMARY KEY (id),
  CONSTRAINT agent_tool_calls_run_seq_key UNIQUE (app_id, run_id, seq),
  CONSTRAINT agent_tool_calls_run_fkey FOREIGN KEY (app_id, run_id)
    REFERENCES app.agent_runs (app_id, id),
  CONSTRAINT agent_tool_calls_seq_check CHECK (seq >= 1),
  CONSTRAINT agent_tool_calls_latency_check CHECK (latency_ms >= 0)
);

CREATE INDEX agent_tool_calls_created_idx ON app.agent_tool_calls (app_id, created_at);

CREATE TABLE app.agent_result_sets (
  id         uuid NOT NULL,
  app_id     text NOT NULL,
  run_id     uuid NOT NULL,
  conditions jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_result_sets_pkey PRIMARY KEY (id),
  CONSTRAINT agent_result_sets_run_fkey FOREIGN KEY (app_id, run_id)
    REFERENCES app.agent_runs (app_id, id),
  CONSTRAINT agent_result_sets_conditions_check CHECK (jsonb_typeof(conditions) = 'object')
);

CREATE INDEX agent_result_sets_run_idx ON app.agent_result_sets (app_id, run_id);
CREATE INDEX agent_result_sets_created_idx ON app.agent_result_sets (app_id, created_at);

CREATE TABLE app.agent_cards (
  id             uuid NOT NULL,
  app_id         text NOT NULL,
  session_id     uuid NOT NULL,
  run_id         uuid NOT NULL,
  card_id        text NOT NULL,
  type           text NOT NULL,
  data           jsonb NOT NULL,
  link_id        uuid,
  schema_version integer NOT NULL,
  fallback_text  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_cards_pkey PRIMARY KEY (id),
  CONSTRAINT agent_cards_session_card_key UNIQUE (app_id, session_id, card_id),
  CONSTRAINT agent_cards_run_fkey FOREIGN KEY (app_id, session_id, run_id)
    REFERENCES app.agent_runs (app_id, session_id, id),
  CONSTRAINT agent_cards_link_fkey FOREIGN KEY (app_id, link_id)
    REFERENCES app.links (app_id, link_id),
  CONSTRAINT agent_cards_card_id_check CHECK (card_id ~ '^c[1-9][0-9]*$'),
  -- contracts/enums/ops.yaml agent_card_type
  CONSTRAINT agent_cards_type_check CHECK (type IN (
    'product_list', 'rebate_quote', 'order_status', 'claim_draft', 'handoff', 'auth_required',
    'notice', 'rule_ref', 'page_guide', 'earnings_summary'
  )),
  CONSTRAINT agent_cards_data_check CHECK (jsonb_typeof(data) = 'object'),
  -- earnings_summary keeps only as_of and actions, never amounts (BR-AI-19 细则, D32).
  CONSTRAINT agent_cards_earnings_no_amount_check CHECK (
    CASE
      WHEN type <> 'earnings_summary' THEN true
      WHEN jsonb_typeof(data) = 'object' THEN (data - 'as_of' - 'actions') = '{}'::jsonb
      ELSE false
    END
  ),
  CONSTRAINT agent_cards_schema_version_check CHECK (schema_version >= 1),
  CONSTRAINT agent_cards_fallback_text_check CHECK (fallback_text <> '')
);

CREATE INDEX agent_cards_run_idx ON app.agent_cards (app_id, run_id);
CREATE INDEX agent_cards_created_idx ON app.agent_cards (app_id, created_at);

-- Prohibitive triggers only (db/AGENTS.md rule 8), raising restrict_violation (23001).
CREATE FUNCTION app.reject_agent_session_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF ROW(NEW.id, NEW.app_id, NEW.user_id, NEW.device_id, NEW.started_at, NEW.created_at)
      IS DISTINCT FROM
      ROW(OLD.id, OLD.app_id, OLD.user_id, OLD.device_id, OLD.started_at, OLD.created_at)
    OR NEW.card_seq < OLD.card_seq
  THEN
    RAISE EXCEPTION 'agent_sessions owner is immutable and card_seq never decreases'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.reject_agent_session_rewrite() FROM PUBLIC;

CREATE TRIGGER agent_sessions_no_rewrite
  BEFORE UPDATE ON app.agent_sessions
  FOR EACH ROW EXECUTE FUNCTION app.reject_agent_session_rewrite();

CREATE FUNCTION app.reject_agent_run_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF ROW(NEW.id, NEW.app_id, NEW.session_id, NEW.prompt_version, NEW.accepted_at,
         NEW.quota_subjects, NEW.created_at)
      IS DISTINCT FROM
      ROW(OLD.id, OLD.app_id, OLD.session_id, OLD.prompt_version, OLD.accepted_at,
          OLD.quota_subjects, OLD.created_at)
    OR (OLD.final_event IS NOT NULL AND NEW.final_event IS DISTINCT FROM OLD.final_event)
    OR (OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at)
    OR (OLD.end_reason IS NOT NULL AND NEW.end_reason IS DISTINCT FROM OLD.end_reason)
    OR (OLD.settle_result IS NOT NULL AND NEW.settle_result IS DISTINCT FROM OLD.settle_result)
    OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at)
    OR (OLD.card_delivered AND NOT NEW.card_delivered)
    OR (OLD.settle_result IS NOT NULL AND NEW.card_delivered IS DISTINCT FROM OLD.card_delivered)
    OR (NEW.user_text IS NOT NULL AND NEW.user_text IS DISTINCT FROM OLD.user_text)
  THEN
    RAISE EXCEPTION 'agent_runs ending facts are write-once and user_text may only be cleared'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.reject_agent_run_rewrite() FROM PUBLIC;

CREATE TRIGGER agent_runs_no_rewrite
  BEFORE UPDATE ON app.agent_runs
  FOR EACH ROW EXECUTE FUNCTION app.reject_agent_run_rewrite();

GRANT SELECT, INSERT ON
  app.agent_sessions, app.agent_runs, app.agent_messages, app.agent_tool_calls,
  app.agent_result_sets, app.agent_cards
  TO couli_app;
GRANT UPDATE (last_active_at, expired_at, card_seq, row_version, updated_at)
  ON app.agent_sessions TO couli_app;
GRANT UPDATE (
  user_text, intent, model, model_snapshot, input_tokens, output_tokens, cost_mfen, ttft_ms,
  latency_ms, finish_reason, final_event, ended_at, output_filtered, filter_hits,
  output_truncated, price_version, result_check_provider, judge_model, page_guide_reject_reason,
  end_reason, card_delivered, settle_result, settled_at, row_version, updated_at
) ON app.agent_runs TO couli_app;
GRANT UPDATE (
  text, card_ids, feedback, feedback_at, reported, report_reason, reported_at, report_status,
  report_handler_id, report_handled_at, report_note, badcase, row_version, updated_at
) ON app.agent_messages TO couli_app;

GRANT SELECT ON app.agent_sessions, app.agent_cards TO couli_readonly;
GRANT SELECT (
  id, app_id, session_id, intent, model, model_snapshot, prompt_version, input_tokens,
  output_tokens, cost_mfen, ttft_ms, latency_ms, finish_reason, final_event, ended_at,
  output_filtered, filter_hits, output_truncated, price_version, result_check_provider,
  judge_model, page_guide_reject_reason, accepted_at, quota_subjects, end_reason, card_delivered,
  settle_result, settled_at, row_version, created_at, updated_at
) ON app.agent_runs TO couli_readonly;
GRANT SELECT (
  id, app_id, session_id, run_id, client_msg_id, role, card_ids, feedback, feedback_at, reported,
  reported_at, report_status, report_handler_id, report_handled_at, report_note, badcase,
  row_version, created_at, updated_at
) ON app.agent_messages TO couli_readonly;
GRANT SELECT (
  id, app_id, run_id, seq, name, result_digest, status, latency_ms, created_at
) ON app.agent_tool_calls TO couli_readonly;
GRANT SELECT (id, app_id, run_id, created_at) ON app.agent_result_sets TO couli_readonly;
