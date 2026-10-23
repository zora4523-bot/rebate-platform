-- Up Migration
-- Payout core tables: payout_batches (打款批次), payout_batch_items (批次成员明细),
-- payout_attempts (通道调用记录) and payout_watermarks (垫资水位手工录入).
-- 规划/04 §3.2 rows payout_batches, payout_batch_items, payout_attempts; §2.4 payout_batch_items.result;
-- 规划/08 BR-WDR-11 (one open batch per APPROVED withdrawal, no second approver), BR-WDR-12
-- (batches never change a withdrawal's state; a re-attached member is recorded as moved_out),
-- BR-WDR-13 (record-then-send: the transfer attempt row exists before the request leaves),
-- BR-WDR-18 / D10-223 (watermark W entered by finance until BR-WDR-22 ⑦ is verified; insert only,
-- the latest row counts). Task B2-06a (withdraw lane).
-- Compatibility: additive. Four new ordinary tables in schema app with named constraints and
-- indexes, three insert-only triggers (app.reject_update_delete of 0003), one trigger limiting
-- payout_attempts updates to completing a pending row once, grants, and one new foreign key on
-- withdrawals.batch_id, added NOT VALID here and validated by the next migration (B2-05b left the gap).
-- Recovery: restore from backup; no down migration.
--
-- payout_batches: a batch is only a set of APPROVED withdrawals (BR-WDR-12); kind manual (built by
--   an operator, created_by required) or auto (one per auto-approved withdrawal, created_by null,
--   BR-WDR-30). "Finished" is derived from the member rows, never stored (04 §3.2).
-- payout_batch_items: insert-only member outcomes of one EXECUTE: paying (moved to PAYING),
--   skipped / blocked (left in APPROVED, reason required), moved_out (re-attached to
--   moved_to_batch_id by a later manual batch; the original row stays). The batch a withdrawal is
--   currently on is withdrawals.batch_id (BR-WDR-11).
-- payout_attempts: one row per channel call (transfer / query / cancel); at most one transfer row
--   per withdrawal (partial unique index, BR-WDR-12 ② / BR-WDR-13 ②). The transfer row is
--   inserted with result = pending inside the daily advisory lock and committed before the request
--   is sent (BR-WDR-13 ④); the only allowed update completes that pending row once with the
--   response (response, resp_code, resp_sub_code, result, latency_ms). Rows are never deleted and a
--   settled result never changes (04 §3.2「只插入」read as append-only plus completing the pending
--   row, D10-223 era default). request is a masked summary (logon id masked, BR-WDR-13 细则).
--   at is the business instant from the injected Clock; the default is a fallback.
-- payout_watermarks: finance enters the channel's available balance W with its measurement time
--   (BR-WDR-18, BR-WDR-22 ⑦); insert only, the latest measured_at per (app_id, channel) is the
--   current W; EXECUTE refuses the batch when the latest row is older than two hours or missing.
-- Retention: none (financial records are kept).
--
-- Grants (least privilege): couli_app SELECT, INSERT on payout_batches, payout_batch_items and
-- payout_watermarks (batches, EXECUTE outcomes and watermark entries are written by the api / admin
-- entries), SELECT only on payout_attempts. couli_payout SELECT on all four, INSERT on
-- payout_attempts and UPDATE only of the completion columns of payout_attempts. couli_readonly
-- SELECT. Nobody deletes, truncates, references or creates triggers; couli_maint nothing.
--
-- Timeouts: four new empty tables, their indexes and triggers; short catalog locks plus SHARE ROW
-- EXCLUSIVE on withdrawals for the new foreign key. 5s lock wait so a blocked deploy fails fast,
-- 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.payout_batches (
  id          uuid        NOT NULL,
  app_id      text        NOT NULL,
  kind        text        NOT NULL,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_batches_pkey PRIMARY KEY (id),
  CONSTRAINT payout_batches_kind_check CHECK (kind IN ('manual', 'auto')),
  CONSTRAINT payout_batches_created_by_check
    CHECK ((kind = 'manual') = (created_by IS NOT NULL) AND (created_by IS NULL OR created_by <> ''))
);

CREATE INDEX payout_batches_app_created_idx ON app.payout_batches (app_id, created_at);

CREATE TABLE app.payout_batch_items (
  id                 uuid        NOT NULL,
  app_id             text        NOT NULL,
  batch_id           uuid        NOT NULL,
  withdrawal_id      uuid        NOT NULL,
  result             text        NOT NULL,
  reason             text,
  moved_to_batch_id  uuid,
  at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_batch_items_pkey PRIMARY KEY (id),
  CONSTRAINT payout_batch_items_batch_fkey FOREIGN KEY (batch_id) REFERENCES app.payout_batches (id),
  CONSTRAINT payout_batch_items_withdrawal_fkey FOREIGN KEY (withdrawal_id) REFERENCES app.withdrawals (id),
  CONSTRAINT payout_batch_items_moved_to_fkey FOREIGN KEY (moved_to_batch_id) REFERENCES app.payout_batches (id),
  CONSTRAINT payout_batch_items_result_check
    CHECK (result IN ('paying', 'skipped', 'blocked', 'moved_out')),
  CONSTRAINT payout_batch_items_reason_check
    CHECK (
      (result IN ('skipped', 'blocked') AND reason IS NOT NULL AND reason <> '' AND moved_to_batch_id IS NULL)
      OR (result = 'moved_out' AND moved_to_batch_id IS NOT NULL AND moved_to_batch_id <> batch_id AND reason IS NULL)
      OR (result = 'paying' AND reason IS NULL AND moved_to_batch_id IS NULL)
    )
);

CREATE INDEX payout_batch_items_batch_at_idx ON app.payout_batch_items (batch_id, at);
CREATE INDEX payout_batch_items_withdrawal_at_idx ON app.payout_batch_items (withdrawal_id, at);

CREATE TRIGGER payout_batch_items_insert_only
  BEFORE UPDATE OR DELETE ON app.payout_batch_items
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

CREATE TABLE app.payout_attempts (
  id             uuid        NOT NULL,
  app_id         text        NOT NULL,
  withdrawal_id  uuid        NOT NULL,
  kind           text        NOT NULL,
  request        jsonb       NOT NULL,
  response       jsonb,
  resp_code      text,
  resp_sub_code  text,
  result         text        NOT NULL,
  latency_ms     integer,
  at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_attempts_pkey PRIMARY KEY (id),
  CONSTRAINT payout_attempts_withdrawal_fkey FOREIGN KEY (withdrawal_id) REFERENCES app.withdrawals (id),
  CONSTRAINT payout_attempts_kind_check CHECK (kind IN ('transfer', 'query', 'cancel')),
  CONSTRAINT payout_attempts_result_check CHECK (result IN ('pending', 'success', 'fail', 'unknown')),
  CONSTRAINT payout_attempts_latency_check CHECK (latency_ms IS NULL OR latency_ms >= 0)
);

CREATE INDEX payout_attempts_withdrawal_at_idx ON app.payout_attempts (withdrawal_id, at);
CREATE INDEX payout_attempts_transfer_at_idx ON app.payout_attempts (app_id, at) WHERE kind = 'transfer';
-- BR-WDR-12 ② / BR-WDR-13 ②: a withdrawal has at most one transfer attempt, enforced here and not
-- only by the read before the advisory lock (D10-237; a re-submission under BR-WDR-22 ④ would need
-- its own migration and money review).
CREATE UNIQUE INDEX payout_attempts_transfer_once_key ON app.payout_attempts (withdrawal_id)
  WHERE kind = 'transfer';

-- A pending attempt may be completed once; nothing else changes and nothing is deleted.
CREATE FUNCTION app.payout_attempts_complete_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payout_attempts rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.result <> 'pending' THEN
    RAISE EXCEPTION 'payout_attempts: a settled attempt never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.result = 'pending' THEN
    RAISE EXCEPTION 'payout_attempts: completing an attempt needs a settled result' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.app_id IS DISTINCT FROM OLD.app_id
     OR NEW.withdrawal_id IS DISTINCT FROM OLD.withdrawal_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.request IS DISTINCT FROM OLD.request OR NEW.at IS DISTINCT FROM OLD.at THEN
    RAISE EXCEPTION 'payout_attempts: only the completion columns may change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payout_attempts_complete_once
  BEFORE UPDATE OR DELETE ON app.payout_attempts
  FOR EACH ROW EXECUTE FUNCTION app.payout_attempts_complete_once();

CREATE TABLE app.payout_watermarks (
  id             uuid        NOT NULL,
  app_id         text        NOT NULL,
  channel        text        NOT NULL,
  available_fen  bigint      NOT NULL,
  measured_at    timestamptz NOT NULL,
  entered_by     text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_watermarks_pkey PRIMARY KEY (id),
  CONSTRAINT payout_watermarks_channel_check CHECK (channel IN ('alipay', 'bank_card', 'wechat')),
  CONSTRAINT payout_watermarks_available_check CHECK (available_fen >= 0),
  CONSTRAINT payout_watermarks_entered_by_check CHECK (entered_by <> '')
);
-- No CHECK against created_at for measured_at: that would compare the injected Clock with the
-- database clock (D10-241); the entry API (B2-09) rejects a measurement time in the future instead.

CREATE INDEX payout_watermarks_latest_idx ON app.payout_watermarks (app_id, channel, measured_at DESC);

CREATE TRIGGER payout_watermarks_insert_only
  BEFORE UPDATE OR DELETE ON app.payout_watermarks
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

-- Added NOT VALID (new rows and updates are checked at once); the validation of existing rows is its
-- own migration, as a funds table takes no squawk exception (precedent 0071 / 0072).
ALTER TABLE app.withdrawals
  ADD CONSTRAINT withdrawals_batch_fkey FOREIGN KEY (batch_id) REFERENCES app.payout_batches (id) NOT VALID;

GRANT SELECT, INSERT ON app.payout_batches TO couli_app;
GRANT SELECT ON app.payout_batches TO couli_payout;
GRANT SELECT ON app.payout_batches TO couli_readonly;

GRANT SELECT, INSERT ON app.payout_batch_items TO couli_app;
GRANT SELECT ON app.payout_batch_items TO couli_payout;
GRANT SELECT ON app.payout_batch_items TO couli_readonly;

GRANT SELECT ON app.payout_attempts TO couli_app;
GRANT SELECT, INSERT ON app.payout_attempts TO couli_payout;
GRANT UPDATE (response, resp_code, resp_sub_code, result, latency_ms) ON app.payout_attempts TO couli_payout;
GRANT SELECT ON app.payout_attempts TO couli_readonly;

GRANT SELECT, INSERT ON app.payout_watermarks TO couli_app;
GRANT SELECT ON app.payout_watermarks TO couli_payout;
GRANT SELECT ON app.payout_watermarks TO couli_readonly;
