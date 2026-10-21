-- Up Migration
-- Settlement core tables: settle_jobs (定时任务运行记录), settle_bills (月结账单), settle_batches
-- (结算批次, with the S8 停住标记), settle_batch_items (批次明细: 子订单行与受益人补记项),
-- beneficiary_credits (待补记义务), settle_adjust_batches / settle_adjustments (正差补差候选) and
-- recon_union (R1 联盟对账明细).
-- 规划/04 §3.2 rows settle_jobs, settle_bills, settle_batches, settle_batch_items,
-- beneficiary_credits, settle_adjust_batches / settle_adjustments, recon_union; §2.5 enums;
-- 规划/08 BR-FUND-04 (③–⑫), BR-FUND-09, BR-CALC-23. Task B2-04a; settlement plan rulings S7 A
-- (settle_jobs.status three states), S8 A (nullable settle_batches.paused_by_switch_at), S14 A
-- (payout batch members belong to B2-06, not here), S20 A (settle_jobs unique key makes a rerun of
-- the same nominal run_at idempotent); decisions 41 / 42 (columns couli_app may update).
-- Compatibility: additive. Eight new ordinary tables in schema app with named constraints and
-- indexes, and grants; no existing object changes (the foreign keys take a SHARE ROW EXCLUSIVE
-- lock on order_keys, users, admin_users and ledger_vouchers while they are added).
-- Recovery: restore from backup; no down migration.
--
-- Common: app_id text NOT NULL on every table; money columns bigint fen; every foreign key carries
-- app_id (no cross-app reference), is named and never cascades; order references point to
-- order_keys (app_id, order_id), never to the partitioned orders table. Status columns take the
-- values of contracts/enums/fund.yaml and of specs/state-machines/{settle-batch,
-- beneficiary-credit,settle-adjustment}.yaml; transitions go through the generated transition()
-- (the CHECKs below only keep each row's fields consistent with its state). Tables whose status
-- moves (settle_jobs, settle_batches, beneficiary_credits, settle_adjustments) carry row_version
-- integer NOT NULL DEFAULT 0 for the CAS of ADR-0001 §4.1 and 04's 状态迁移 row (SET status =
-- :to, row_version = row_version + 1 WHERE … AND row_version = :read): a status check alone misses
-- a round trip between read and write (settle-batch CONFIRMED → DRAFT, PARTIAL ↔ EXECUTING,
-- EXECUTING → EXECUTING; a failed job run back to running). settle_bills,
-- settle_batch_items and settle_adjust_batches have no status; their columns are filled once
-- (guarded by IS NULL), so they carry none. Business instants
-- (run_at, *_at) come from the injected Clock and have no database default; only created_at
-- defaults to now(). Writer of every table: settlement.
--
-- settle_jobs: one row per (app_id, job, platform, run_at) (04; S20: run_at is the nominal instant
--   the worker computes from the injected Clock, a rerun reuses it and hits the unique key).
--   job: bill / settle_adjust / recon_union / recon_monthly (02 §11 job names; no credit, clawback
--   or batch_execute: batch progress lives in settle_batches / settle_batch_items).
--   status (S7, codes chosen by the agent, 04 gives none): running / done / failed; finished_at is
--   set exactly when the run is no longer running. platform: the platform the run covers (text;
--   04 fixes no list for job runs, so only non-empty is checked here).
-- settle_bills: one row per (app_id, bill_id) (bill_id = 账单月 YYYY-MM). Inserted when generation
--   starts (generation_started_at), the six totals and generated_at are filled when it completes
--   (decision 42); the bill status is derived from its batches and not stored (BR-FUND-04 ⑥).
--   platform_order_counts: JSON object platform → 子订单数; platform_settle_commission_totals:
--   JSON object platform → 联盟结算佣金合计 in fen as an integer string (no JSON number precision
--   loss); beneficiary_total_fen / platform_retained_fen: 受益人份额合计 / 平台留存合计;
--   error_count / held_count: 差错单数 / 暂缓数 (persisted, not derived from batch items).
-- settle_batches: (platform, bill) batches, kind main / supplement (BR-FUND-04 ⑤ ⑧). status:
--   settle_batch_status (SB1–SB9); settle_mode: IMMEDIATE / SCHEDULED, scheduled_at only for
--   SCHEDULED; every state after confirmation carries confirmed_by / confirmed_at (CANCELLED may
--   or may not, SB4 rejects a DRAFT); CANCELLED carries cancelled_reason. paused_by_switch_at (S8):
--   when the batch was stopped because settle.auto.enabled or credit.enabled.<platform> was off
--   (SB5 / SB7); cleared on manual resume. order_count: 子订单数 fixed at generation.
-- settle_batch_items: item_type order (子订单行) / beneficiary (受益人补记项, BR-FUND-04 ⑫).
--   Order rows: user_id, role, beneficiary_credit_id are null and b_settle_fen (B_settle at
--   validation) is present; one row per (app_id, batch_id, order_id) (partial unique). Beneficiary
--   rows: user_id, role, beneficiary_credit_id are all present and must match the obligation's
--   order, user and role (composite foreign key); one row per (app_id, batch_id,
--   beneficiary_credit_id) (partial unique); the same obligation may appear in several batches.
--   settle_seq: order_settlements.seq at validation. amount_fen: the amount recomputed when a
--   beneficiary item executes (decision 41; >= 0, beneficiary rows only). result: credited /
--   skipped / deferred (deferred only for beneficiary rows), null until executed.
-- beneficiary_credits: 待补记义务, at most one open per (app_id, order_id, user_id, role) (partial
--   unique). kind ↔ opened_by: first_credit ← R5, reassign_credit ← R14, deferred ← R10 / R13 (04).
--   origin_ledger_type / origin_sub_type are set exactly for kind = deferred (fixed at opening).
--   opened_ref / split_ref: the opening reference and the attribution snapshot (text ids).
--   No amount column: the remaining amount is recomputed from booked_base_fen and net amounts.
--   An open obligation has no closing fields; a closed one has closed_by, closed_ref, closed_at;
--   voided is closed by R8 / R14 and only by them; voucher_id (foreign key to ledger_vouchers) only
--   on done / forfeited, null when the amount was 0 or no voucher was written.
-- settle_adjust_batches: approval batch of positive-diff candidates (confirmed_by / confirmed_at
--   both or neither).
-- settle_adjustments: positive-diff candidates (BR-FUND-09 ②, BR-CALC-23 (a)). user_id / role
--   both null on the platform row; diff_fen is the generation-time diff, never 0, > 0 for a
--   beneficiary row, any sign for the platform row (rounding). One candidate per (app_id, order_id,
--   settle_seq, commission_version, user_id, role) (nulls not distinct), so a rerun of R1 on the
--   same settlement record does not duplicate. status: settle_adjustment_status; pending has no
--   decision; approved / rejected carry the approver; every decided row carries decided_at.
--   reason: generation reason, replaced by the rejection reason on rejection.
-- recon_union: R1 联盟对账明细. order_key keeps the union's business key as given (also for orders
--   we do not have), so it is not a foreign key. our_value / union_value: fen, null when that side
--   has no record (at least one present); diff_fen = our_value − union_value when both are present.
--   period: YYYY-MM or YYYY-MM-DD. result: non-empty text (no enum in contracts yet).
-- Retention: none (financial records are kept).
--
-- Grants: couli_app SELECT, INSERT on the eight tables; UPDATE only on the columns the settlement
-- commands change — settle_jobs (status, processed_count, skipped_count, finished_at,
-- row_version); settle_bills (the six totals, generated_at); settle_batches (status, settle_mode,
-- scheduled_at, confirmed_by, confirmed_at, cancelled_reason, settle_run_id, started_at,
-- finished_at, paused_by_switch_at, row_version); settle_batch_items (amount_fen, result,
-- skip_reason); beneficiary_credits (status, closed_by, closed_ref, voucher_id, closed_at,
-- row_version); settle_adjust_batches (confirmed_by, confirmed_at); settle_adjustments (status,
-- approver, decided_at, reason, row_version); none on recon_union.
-- Never on identities, keys or the other money columns. No DELETE, TRUNCATE, REFERENCES or
-- TRIGGER for anyone. couli_readonly SELECT.
--
-- Timeouts: eight new empty tables and their indexes; short catalog locks only (plus SHARE ROW
-- EXCLUSIVE on order_keys, users, admin_users and ledger_vouchers for the foreign keys). 5s lock
-- wait so a blocked deploy fails fast, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.settle_jobs (
  id              uuid        NOT NULL,
  app_id          text        NOT NULL,
  job             text        NOT NULL,
  platform        text        NOT NULL,
  run_at          timestamptz NOT NULL,
  status          text        NOT NULL,
  processed_count integer     NOT NULL,
  skipped_count   integer     NOT NULL,
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz,
  row_version     integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settle_jobs_pkey PRIMARY KEY (id),
  CONSTRAINT settle_jobs_run_key UNIQUE (app_id, job, platform, run_at),
  CONSTRAINT settle_jobs_job_check
    CHECK (job IN ('bill', 'settle_adjust', 'recon_union', 'recon_monthly')),
  CONSTRAINT settle_jobs_platform_check CHECK (platform <> ''),
  CONSTRAINT settle_jobs_status_check CHECK (status IN ('running', 'done', 'failed')),
  CONSTRAINT settle_jobs_finished_check CHECK ((status = 'running') = (finished_at IS NULL)),
  CONSTRAINT settle_jobs_counts_check CHECK (processed_count >= 0 AND skipped_count >= 0)
);

CREATE TABLE app.settle_bills (
  app_id                            text        NOT NULL,
  bill_id                           text        NOT NULL,
  generation_started_at             timestamptz NOT NULL,
  generated_at                      timestamptz,
  platform_order_counts             jsonb,
  platform_settle_commission_totals jsonb,
  beneficiary_total_fen             bigint,
  platform_retained_fen             bigint,
  error_count                       integer,
  held_count                        integer,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settle_bills_pkey PRIMARY KEY (app_id, bill_id),
  CONSTRAINT settle_bills_bill_id_check CHECK (bill_id ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT settle_bills_order_counts_check
    CHECK (jsonb_typeof(platform_order_counts) = 'object'),
  CONSTRAINT settle_bills_commission_totals_check
    CHECK (jsonb_typeof(platform_settle_commission_totals) = 'object'),
  CONSTRAINT settle_bills_counts_check CHECK (error_count >= 0 AND held_count >= 0)
);

CREATE TABLE app.settle_batches (
  batch_id            uuid        NOT NULL,
  app_id              text        NOT NULL,
  bill_id             text        NOT NULL,
  platform            text        NOT NULL,
  kind                text        NOT NULL,
  status              text        NOT NULL,
  settle_mode         text        NOT NULL,
  scheduled_at        timestamptz,
  confirmed_by        uuid,
  confirmed_at        timestamptz,
  cancelled_reason    text,
  settle_run_id       uuid,
  order_count         integer     NOT NULL,
  started_at          timestamptz,
  finished_at         timestamptz,
  paused_by_switch_at timestamptz,
  row_version         integer     NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settle_batches_pkey PRIMARY KEY (batch_id),
  CONSTRAINT settle_batches_app_id_batch_id_key UNIQUE (app_id, batch_id),
  CONSTRAINT settle_batches_bill_fkey FOREIGN KEY (app_id, bill_id)
    REFERENCES app.settle_bills (app_id, bill_id),
  CONSTRAINT settle_batches_confirmed_by_fkey FOREIGN KEY (app_id, confirmed_by)
    REFERENCES app.admin_users (app_id, id),
  CONSTRAINT settle_batches_platform_check CHECK (platform IN (
    'taobao', 'jd', 'pdd', 'meituan', 'vip', 'douyin', 'eleme', 'kuaishou', 'suning'
  )),
  CONSTRAINT settle_batches_kind_check CHECK (kind IN ('main', 'supplement')),
  CONSTRAINT settle_batches_status_check CHECK (status IN (
    'DRAFT', 'CONFIRMED', 'EXECUTING', 'PARTIAL', 'DONE', 'CANCELLED'
  )),
  CONSTRAINT settle_batches_settle_mode_check CHECK (settle_mode IN ('IMMEDIATE', 'SCHEDULED')),
  CONSTRAINT settle_batches_scheduled_check
    CHECK (settle_mode = 'SCHEDULED' OR scheduled_at IS NULL),
  CONSTRAINT settle_batches_confirmed_pair_check
    CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL)),
  CONSTRAINT settle_batches_confirmed_check CHECK (
    status NOT IN ('CONFIRMED', 'EXECUTING', 'PARTIAL', 'DONE') OR confirmed_at IS NOT NULL
  ),
  CONSTRAINT settle_batches_cancelled_reason_check CHECK (
    (status = 'CANCELLED') = (cancelled_reason IS NOT NULL) AND cancelled_reason <> ''
  ),
  CONSTRAINT settle_batches_order_count_check CHECK (order_count >= 0)
);

CREATE INDEX settle_batches_bill_idx ON app.settle_batches (app_id, bill_id, platform);
CREATE INDEX settle_batches_status_idx ON app.settle_batches (app_id, status);

CREATE TABLE app.beneficiary_credits (
  beneficiary_credit_id uuid        NOT NULL,
  app_id                text        NOT NULL,
  order_id              uuid        NOT NULL,
  user_id               uuid        NOT NULL,
  role                  text        NOT NULL,
  kind                  text        NOT NULL,
  opened_by             text        NOT NULL,
  opened_ref            text        NOT NULL,
  origin_ledger_type    text,
  origin_sub_type       text,
  split_ref             text        NOT NULL,
  status                text        NOT NULL,
  closed_by             text,
  closed_ref            text,
  voucher_id            uuid,
  opened_at             timestamptz NOT NULL,
  closed_at             timestamptz,
  row_version           integer     NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT beneficiary_credits_pkey PRIMARY KEY (beneficiary_credit_id),
  CONSTRAINT beneficiary_credits_item_ref_key
    UNIQUE (app_id, beneficiary_credit_id, order_id, user_id, role),
  CONSTRAINT beneficiary_credits_order_fkey FOREIGN KEY (app_id, order_id)
    REFERENCES app.order_keys (app_id, order_id),
  CONSTRAINT beneficiary_credits_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT beneficiary_credits_voucher_fkey FOREIGN KEY (app_id, voucher_id)
    REFERENCES app.ledger_vouchers (app_id, id),
  CONSTRAINT beneficiary_credits_role_check
    CHECK (role IN ('self', 'share', 'direct', 'indirect')),
  CONSTRAINT beneficiary_credits_kind_check
    CHECK (kind IN ('first_credit', 'reassign_credit', 'deferred')),
  CONSTRAINT beneficiary_credits_opened_by_check CHECK (
    (kind = 'first_credit' AND opened_by = 'R5')
    OR (kind = 'reassign_credit' AND opened_by = 'R14')
    OR (kind = 'deferred' AND opened_by IN ('R10', 'R13'))
  ),
  CONSTRAINT beneficiary_credits_opened_ref_check CHECK (opened_ref <> ''),
  CONSTRAINT beneficiary_credits_split_ref_check CHECK (split_ref <> ''),
  CONSTRAINT beneficiary_credits_origin_check CHECK (
    (kind = 'deferred') = (origin_ledger_type IS NOT NULL)
    AND (kind = 'deferred') = (origin_sub_type IS NOT NULL)
    AND origin_ledger_type <> '' AND origin_sub_type <> ''
  ),
  CONSTRAINT beneficiary_credits_status_check
    CHECK (status IN ('open', 'done', 'forfeited', 'voided')),
  CONSTRAINT beneficiary_credits_closed_check CHECK (
    (status = 'open') = (closed_by IS NULL)
    AND (status = 'open') = (closed_ref IS NULL)
    AND (status = 'open') = (closed_at IS NULL)
    AND closed_by <> '' AND closed_ref <> ''
  ),
  CONSTRAINT beneficiary_credits_voided_check
    CHECK (closed_by IS NULL OR (status = 'voided') = (closed_by IN ('R8', 'R14'))),
  CONSTRAINT beneficiary_credits_voucher_check
    CHECK (voucher_id IS NULL OR status IN ('done', 'forfeited'))
);

CREATE UNIQUE INDEX beneficiary_credits_open_key
  ON app.beneficiary_credits (app_id, order_id, user_id, role) WHERE status = 'open';
CREATE INDEX beneficiary_credits_order_idx ON app.beneficiary_credits (app_id, order_id);

CREATE TABLE app.settle_batch_items (
  id                    uuid        NOT NULL,
  app_id                text        NOT NULL,
  batch_id              uuid        NOT NULL,
  item_type             text        NOT NULL,
  order_id              uuid        NOT NULL,
  user_id               uuid,
  role                  text,
  beneficiary_credit_id uuid,
  settle_seq            integer     NOT NULL,
  b_settle_fen          bigint,
  amount_fen            bigint,
  result                text,
  skip_reason           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settle_batch_items_pkey PRIMARY KEY (id),
  CONSTRAINT settle_batch_items_batch_fkey FOREIGN KEY (app_id, batch_id)
    REFERENCES app.settle_batches (app_id, batch_id),
  CONSTRAINT settle_batch_items_order_fkey FOREIGN KEY (app_id, order_id)
    REFERENCES app.order_keys (app_id, order_id),
  CONSTRAINT settle_batch_items_credit_fkey
    FOREIGN KEY (app_id, beneficiary_credit_id, order_id, user_id, role)
    REFERENCES app.beneficiary_credits (app_id, beneficiary_credit_id, order_id, user_id, role),
  CONSTRAINT settle_batch_items_item_type_check CHECK (item_type IN ('order', 'beneficiary')),
  CONSTRAINT settle_batch_items_shape_check CHECK (
    (item_type = 'order' AND user_id IS NULL AND role IS NULL AND beneficiary_credit_id IS NULL
      AND b_settle_fen IS NOT NULL AND amount_fen IS NULL)
    OR (item_type = 'beneficiary' AND user_id IS NOT NULL AND role IS NOT NULL
      AND beneficiary_credit_id IS NOT NULL)
  ),
  CONSTRAINT settle_batch_items_role_check
    CHECK (role IN ('self', 'share', 'direct', 'indirect')),
  CONSTRAINT settle_batch_items_amount_check CHECK (amount_fen >= 0),
  CONSTRAINT settle_batch_items_result_check
    CHECK (result IN ('credited', 'skipped', 'deferred')),
  CONSTRAINT settle_batch_items_deferred_check
    CHECK (result <> 'deferred' OR item_type = 'beneficiary'),
  CONSTRAINT settle_batch_items_skip_reason_check CHECK (skip_reason <> '')
);

CREATE UNIQUE INDEX settle_batch_items_order_key
  ON app.settle_batch_items (app_id, batch_id, order_id) WHERE item_type = 'order';
CREATE UNIQUE INDEX settle_batch_items_beneficiary_key
  ON app.settle_batch_items (app_id, batch_id, beneficiary_credit_id)
  WHERE item_type = 'beneficiary';
CREATE INDEX settle_batch_items_order_idx ON app.settle_batch_items (app_id, order_id);

CREATE TABLE app.settle_adjust_batches (
  batch_id     uuid        NOT NULL,
  app_id       text        NOT NULL,
  confirmed_by uuid,
  confirmed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settle_adjust_batches_pkey PRIMARY KEY (batch_id),
  CONSTRAINT settle_adjust_batches_app_id_batch_id_key UNIQUE (app_id, batch_id),
  CONSTRAINT settle_adjust_batches_confirmed_by_fkey FOREIGN KEY (app_id, confirmed_by)
    REFERENCES app.admin_users (app_id, id),
  CONSTRAINT settle_adjust_batches_confirmed_check
    CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL))
);

CREATE TABLE app.settle_adjustments (
  id                 uuid        NOT NULL,
  app_id             text        NOT NULL,
  batch_id           uuid        NOT NULL,
  order_id           uuid        NOT NULL,
  user_id            uuid,
  role               text,
  commission_version integer     NOT NULL,
  settle_seq         integer     NOT NULL,
  diff_fen           bigint      NOT NULL,
  reason             text,
  status             text        NOT NULL,
  approver           uuid,
  decided_at         timestamptz,
  row_version        integer     NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settle_adjustments_pkey PRIMARY KEY (id),
  CONSTRAINT settle_adjustments_candidate_key
    UNIQUE NULLS NOT DISTINCT (app_id, order_id, settle_seq, commission_version, user_id, role),
  CONSTRAINT settle_adjustments_batch_fkey FOREIGN KEY (app_id, batch_id)
    REFERENCES app.settle_adjust_batches (app_id, batch_id),
  CONSTRAINT settle_adjustments_order_fkey FOREIGN KEY (app_id, order_id)
    REFERENCES app.order_keys (app_id, order_id),
  CONSTRAINT settle_adjustments_user_fkey FOREIGN KEY (app_id, user_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT settle_adjustments_approver_fkey FOREIGN KEY (app_id, approver)
    REFERENCES app.admin_users (app_id, id),
  CONSTRAINT settle_adjustments_beneficiary_check CHECK ((user_id IS NULL) = (role IS NULL)),
  CONSTRAINT settle_adjustments_role_check
    CHECK (role IN ('self', 'share', 'direct', 'indirect')),
  CONSTRAINT settle_adjustments_diff_check
    CHECK (diff_fen <> 0 AND (user_id IS NULL OR diff_fen > 0)),
  CONSTRAINT settle_adjustments_status_check CHECK (status IN (
    'pending', 'approved', 'rejected', 'voided_stale_seq', 'voided_by_clawback'
  )),
  CONSTRAINT settle_adjustments_decision_check CHECK (
    (status = 'pending' AND approver IS NULL AND decided_at IS NULL)
    OR (status IN ('approved', 'rejected') AND approver IS NOT NULL AND decided_at IS NOT NULL)
    OR (status IN ('voided_stale_seq', 'voided_by_clawback') AND decided_at IS NOT NULL)
  ),
  CONSTRAINT settle_adjustments_reason_check CHECK (reason <> '')
);

CREATE INDEX settle_adjustments_batch_idx ON app.settle_adjustments (app_id, batch_id);
CREATE INDEX settle_adjustments_status_idx ON app.settle_adjustments (app_id, status);

CREATE TABLE app.recon_union (
  id          uuid        NOT NULL,
  app_id      text        NOT NULL,
  platform    text        NOT NULL,
  period      text        NOT NULL,
  order_key   text        NOT NULL,
  our_value   bigint,
  union_value bigint,
  diff_fen    bigint      NOT NULL,
  result      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recon_union_pkey PRIMARY KEY (id),
  CONSTRAINT recon_union_platform_check CHECK (platform IN (
    'taobao', 'jd', 'pdd', 'meituan', 'vip', 'douyin', 'eleme', 'kuaishou', 'suning'
  )),
  CONSTRAINT recon_union_period_check
    CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$'),
  CONSTRAINT recon_union_order_key_check CHECK (order_key <> ''),
  CONSTRAINT recon_union_values_check CHECK (our_value IS NOT NULL OR union_value IS NOT NULL),
  CONSTRAINT recon_union_diff_check CHECK (
    our_value IS NULL OR union_value IS NULL OR diff_fen = our_value - union_value
  ),
  CONSTRAINT recon_union_result_check CHECK (result <> '')
);

CREATE INDEX recon_union_period_idx ON app.recon_union (app_id, period, platform);

GRANT SELECT, INSERT ON app.settle_jobs TO couli_app;
GRANT UPDATE (status, processed_count, skipped_count, finished_at, row_version)
  ON app.settle_jobs TO couli_app;
GRANT SELECT, INSERT ON app.settle_bills TO couli_app;
GRANT UPDATE (
  platform_order_counts, platform_settle_commission_totals, beneficiary_total_fen,
  platform_retained_fen, error_count, held_count, generated_at
) ON app.settle_bills TO couli_app;
GRANT SELECT, INSERT ON app.settle_batches TO couli_app;
GRANT UPDATE (
  status, settle_mode, scheduled_at, confirmed_by, confirmed_at, cancelled_reason, settle_run_id,
  started_at, finished_at, paused_by_switch_at, row_version
) ON app.settle_batches TO couli_app;
GRANT SELECT, INSERT ON app.settle_batch_items TO couli_app;
GRANT UPDATE (amount_fen, result, skip_reason) ON app.settle_batch_items TO couli_app;
GRANT SELECT, INSERT ON app.beneficiary_credits TO couli_app;
GRANT UPDATE (status, closed_by, closed_ref, voucher_id, closed_at, row_version)
  ON app.beneficiary_credits TO couli_app;
GRANT SELECT, INSERT ON app.settle_adjust_batches TO couli_app;
GRANT UPDATE (confirmed_by, confirmed_at) ON app.settle_adjust_batches TO couli_app;
GRANT SELECT, INSERT ON app.settle_adjustments TO couli_app;
GRANT UPDATE (status, approver, decided_at, reason, row_version)
  ON app.settle_adjustments TO couli_app;
GRANT SELECT, INSERT ON app.recon_union TO couli_app;
GRANT SELECT ON app.settle_jobs, app.settle_bills, app.settle_batches, app.settle_batch_items,
  app.beneficiary_credits, app.settle_adjust_batches, app.settle_adjustments, app.recon_union
  TO couli_readonly;
