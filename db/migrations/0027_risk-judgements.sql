-- Up Migration
-- Persisted same-device judgements (BR-ID-37 判定时点「提现申请受理时、奖励发放时，各判定一次」;
-- 规划/04 §3.2 risk_hits; BR-ID-36 insert-only hits; ADR-0001 §4). Task B1-03n (orchestrator
-- ruling §9.2: the table is not listed in 04 yet and is written back by a spec-sync task).
-- Compatibility: additive (one new table, its constraints and grants). No existing table changes.
-- Recovery: restore from backup; no down migration.
--
-- risk_judgements: the one conclusion of a judgement per (app_id, rule_id, ref_type, ref_id),
-- e.g. one withdrawal's same-device check. Written by risk only, insert-only: the first judgement
-- (marked or not) inserts the row, and every retry of the same object returns `result` verbatim
-- without recomputing, re-reading configuration or writing anything. Idempotency ends on the PG
-- unique constraint risk_judgements_ref_key (hard rule 4); user_id is not part of it. A concurrent
-- loser that hits 23505 re-reads the stored row.
-- - rule_id references risk_rules (app_id, rule_id) as risk_hits does, so risk registers the rule
--   row (INSERT ... ON CONFLICT DO NOTHING) before writing a judgement, unmarked ones included.
-- - ref_type has exactly the risk_hits set (order, withdrawal, blocked_request); ref_id is text
--   as in risk_hits.
-- - user_id is the judged account, referenced with app_id, never cascading.
-- - result is the full judge return value (devices with rank); marked repeats result.marked for
--   queries and is CHECKed against it.
-- - judged_at is the judgement moment from the injected Clock (ADR-0001 §4.2 #10), no default;
--   created_at defaults to now() only as the row's technical insert time.
-- Rows existing in risk_hits from B1-03k have no judgement row and are not backfilled (no real
-- data before launch); replay reads risk_judgements only.
--
-- Grants: couli_app SELECT and column INSERT (id is an identity, as risk_hits), never UPDATE or
-- DELETE; couli_readonly SELECT. couli_payout and couli_maint get nothing.
--
-- Timeouts: CREATE TABLE with foreign keys takes SHARE ROW EXCLUSIVE locks on app.users and
-- app.risk_rules; 5s lock wait so a blocked deploy fails fast instead of queueing writers behind
-- it, 30s overall as a ceiling for creating one empty table with its indexes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.risk_judgements (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  app_id     text NOT NULL,
  rule_id    text NOT NULL,
  ref_type   text NOT NULL,
  ref_id     text NOT NULL,
  user_id    uuid NOT NULL,
  marked     boolean NOT NULL,
  result     jsonb NOT NULL,
  judged_at  timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_judgements_pkey PRIMARY KEY (id),
  CONSTRAINT risk_judgements_ref_key UNIQUE (app_id, rule_id, ref_type, ref_id),
  CONSTRAINT risk_judgements_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT risk_judgements_rule_fkey FOREIGN KEY (app_id, rule_id)
    REFERENCES app.risk_rules (app_id, rule_id),
  CONSTRAINT risk_judgements_ref_type_check
    CHECK (ref_type IN ('order', 'withdrawal', 'blocked_request')),
  CONSTRAINT risk_judgements_result_check
    CHECK (jsonb_typeof(result) = 'object' AND result -> 'marked' = to_jsonb(marked))
);

GRANT SELECT ON app.risk_judgements TO couli_app;
-- Insert-only; id is an identity; judged_at is the Clock judgement moment (see the header).
GRANT INSERT (
  app_id, rule_id, ref_type, ref_id, user_id, marked, result, judged_at, created_at
) ON app.risk_judgements TO couli_app;
GRANT SELECT ON app.risk_judgements TO couli_readonly;
