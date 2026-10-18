-- Up Migration
-- Commission rule trial reports (BR-CALC-22 试算差异报告; 规划/04 §11). Task B2-03o. One row per
-- trial run of a draft rule version against its base version, kept as evidence for publication
-- (orchestrator decision P3 = A: the report is stored, insert-only, with the rule versions and a
-- hash of the sample). Sample selection, calculation and the publish-time checks are services
-- (B2-03 publication tasks), not this table.
-- Compatibility: additive. One new ordinary table with named constraints and index, one
-- append-only guard trigger, and grants.
-- Recovery: restore from backup; no down migration.
--
-- commission_rule_trials:
--   trial_id: UUIDv7 from the application, primary key; the same draft may be trialled many
--     times (a rerun after the base moved, BR-CALC-22), each run is a new row.
--   rule_version_id: the draft being trialled; base_version_id: the current published version it
--     is compared with, NULL when there is none yet (first version). Both reference
--     app.commission_rule_versions (app_id, rule_version_id), so a trial cannot point at another
--     app's version; no cascade (db/AGENTS.md rule 7; MATCH SIMPLE, NULL base skips the check).
--   sample_from / sample_to: the paid_at window [申请时刻 − 7 天, 申请时刻) of the sample; both
--     from the injected Clock, no database default; CHECK sample_from < sample_to. The 7-day
--     length itself is the service's rule.
--   sample_count >= 0 (an empty window still yields a report); sample_hash: non-empty digest of
--     the sampled orders and their snapshots, so a report can be tied to its exact input.
--   report: the jsonb comparison (per platform reserve_bp, reserve amount, own / direct /
--     indirect shares and platform retain, current vs draft); its shape is the service's, the
--     table only requires a JSON object.
--   created_by: the admin who requested the trial, referencing app.admin_users (app_id, id).
--   created_at: the injected Clock time of the trial, no database default (unlike other tables'
--     technical created_at, it is business evidence compared with publication time).
-- Index (app_id, rule_version_id, created_at): the trial history of a version, latest first by
--   backward scan; it also serves the rule_version_id foreign key. base_version_id lookups are
--   rare (deleting a version never happens) and get no index.
-- Retention: none.
--
-- Grants: couli_app SELECT, INSERT only; no UPDATE / DELETE / TRUNCATE for anyone, and
-- app.reject_update_delete() (0003) rejects UPDATE and DELETE for every role as a second line of
-- defence (rule 8). couli_readonly SELECT. couli_payout and couli_maint get nothing.
--
-- Timeouts: only a new, empty table is created; the only locks on existing tables are the brief
-- SHARE ROW EXCLUSIVE locks on app.commission_rule_versions and app.admin_users for the new
-- foreign keys. 5s lock wait so a blocked deploy fails fast, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.commission_rule_trials (
  trial_id        uuid NOT NULL,
  app_id          text NOT NULL,
  rule_version_id uuid NOT NULL,
  base_version_id uuid,
  sample_from     timestamptz NOT NULL,
  sample_to       timestamptz NOT NULL,
  sample_count    integer NOT NULL,
  sample_hash     text NOT NULL,
  report          jsonb NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL,
  CONSTRAINT commission_rule_trials_pkey PRIMARY KEY (trial_id),
  CONSTRAINT commission_rule_trials_rule_version_id_fkey FOREIGN KEY (app_id, rule_version_id)
    REFERENCES app.commission_rule_versions (app_id, rule_version_id),
  CONSTRAINT commission_rule_trials_base_version_id_fkey FOREIGN KEY (app_id, base_version_id)
    REFERENCES app.commission_rule_versions (app_id, rule_version_id) MATCH SIMPLE,
  CONSTRAINT commission_rule_trials_created_by_fkey FOREIGN KEY (app_id, created_by)
    REFERENCES app.admin_users (app_id, id),
  CONSTRAINT commission_rule_trials_sample_window_check CHECK (sample_from < sample_to),
  CONSTRAINT commission_rule_trials_sample_count_check CHECK (sample_count >= 0),
  CONSTRAINT commission_rule_trials_sample_hash_check CHECK (sample_hash <> ''),
  CONSTRAINT commission_rule_trials_report_check CHECK (jsonb_typeof(report) = 'object')
);

CREATE INDEX commission_rule_trials_version_created_idx
  ON app.commission_rule_trials (app_id, rule_version_id, created_at);

CREATE TRIGGER commission_rule_trials_append_only
  BEFORE UPDATE OR DELETE ON app.commission_rule_trials
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

GRANT SELECT, INSERT ON app.commission_rule_trials TO couli_app;
GRANT SELECT ON app.commission_rule_trials TO couli_readonly;
