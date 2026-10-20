-- Up Migration
-- Ledger-owned settlement tables: recon_diffs (差错单), asset_snapshots (日资产快照) and
-- asset_snapshot_receivables (快照的按平台联盟应收).
-- 规划/04 §3.2 rows recon_diffs / asset_snapshots, §2.5 recon_diff_type / recon_diff_status /
-- recon_diffs.source; 规划/08 BR-FUND-18 (快照字段与 waiting_comparable), BR-FUND-19 (日终差错单),
-- BR-FUND-22 (已作废订单被平台恢复、申诉恢复，可「已关闭（不处理）」结案), BR-FUND-23 (月末三项
-- 不平按 (app_id, 月份) 去重). Task B2-04b; settlement plan rulings S4 A (nullable dedupe_key with a
-- partial unique index, nullable resolution) and S15 A (a row in asset_snapshots means the day's
-- snapshot is complete; union_receivable_fen per platform in a child table, decision 40: the
-- migration gate allows only bigint for *_fen columns, so no jsonb map).
-- Compatibility: additive. Three new ordinary tables in schema app with named constraints and
-- indexes, and grants; no existing object changes.
-- Recovery: restore from backup; no down migration.
--
-- Common: app_id text NOT NULL on every table; money columns bigint fen; every foreign key
-- carries app_id (no cross-app handler or snapshot), is named and never cascades. Business dates
-- and times (period, snapshot_date, closed_at, created_at, updated_at) come from the injected
-- Clock / packages/domain calendar functions and have no database default.
--
-- recon_diffs: one ticket per (app_id, type, period, ref_id) (04). Writer: ledger only (R1 / R2
--   register through ledger commands).
--   type: recon_diff_type (contracts/enums/fund.yaml); source: R1 联盟 / R2 通道 / R3 内部日终 /
--   R4 收款; status: recon_diff_status (open, processing, adjusted, written_off, closed — closed is
--   「已关闭（不处理）」, BR-FUND-22). period: a date (YYYY-MM-DD) or a month (YYYY-MM).
--   expected_fen / actual_fen / diff_fen: signed fen, stored as given (no sign or formula checked
--   here; the registering command computes them).
--   handler_id: the admin who took / closed the ticket, same app (FK on (app_id, handler_id));
--   closed_at: set by the closing command.
--   dedupe_key (S4): NULL for tickets keyed by the business key only; when set, unique within the
--   app across types and references (recon_diffs_dedupe_key_key, partial). Used e.g. for BR-FUND-01
--   R9b 「同单同预估值只生成一次」.
--   month_end_unbalanced (BR-FUND-23): one ticket per (app_id, period) whatever its status or
--   ref_id (recon_diffs_month_end_key, partial), so a rerun of the month never registers again.
--   resolution (S4): NULL until concluded; a JSON object recording the conclusion (e.g. 「结论以
--   联盟为准视为一致」, or the reason for closing without restore). Its keys are not fixed here.
-- asset_snapshots: one row per (app_id, snapshot_date) (BR-FUND-18: written at D+1 00:01 for D).
--   The five totals are bigint fen as computed (no sign check: 08 does not fix one).
--   waiting_comparable: false when the snapshot waited past 00:30 (BR-FUND-18).
-- asset_snapshot_receivables: union_receivable_fen per platform for one snapshot (S15), one row per
--   (asset_snapshot_id, platform), never summed into one number; written in the snapshot's
--   transaction. platform: contracts/enums/platform.yaml. The foreign key is the composite
--   (app_id, asset_snapshot_id) → asset_snapshots (app_id, id), so a row's app_id always equals its
--   snapshot's (asset_snapshots_app_id_id_key backs it). Amount bigint fen as computed, any sign.
-- Retention: none (financial records are kept).
--
-- Grants: couli_app SELECT, INSERT on the three tables; UPDATE only on the columns the ledger
-- commands change — recon_diffs (status, handler_id, closed_at, dedupe_key, resolution, updated_at),
-- asset_snapshots (waiting_comparable, updated_at); none on asset_snapshot_receivables. Never on
-- the money columns or the business key. No DELETE, TRUNCATE, REFERENCES or TRIGGER for anyone.
-- couli_readonly SELECT.
--
-- Timeouts: three new empty tables and their indexes; short catalog locks only (plus a SHARE ROW
-- EXCLUSIVE on admin_users for the handler foreign key). 5s lock wait so a blocked deploy fails
-- fast, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.recon_diffs (
  id           uuid        NOT NULL,
  app_id       text        NOT NULL,
  type         text        NOT NULL,
  source       text        NOT NULL,
  period       text        NOT NULL,
  ref_type     text        NOT NULL,
  ref_id       text        NOT NULL,
  expected_fen bigint      NOT NULL,
  actual_fen   bigint      NOT NULL,
  diff_fen     bigint      NOT NULL,
  status       text        NOT NULL,
  handler_id   uuid,
  closed_at    timestamptz,
  dedupe_key   text,
  resolution   jsonb,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  CONSTRAINT recon_diffs_pkey PRIMARY KEY (id),
  CONSTRAINT recon_diffs_business_key UNIQUE (app_id, type, period, ref_id),
  CONSTRAINT recon_diffs_handler_fkey FOREIGN KEY (app_id, handler_id)
    REFERENCES app.admin_users (app_id, id),
  CONSTRAINT recon_diffs_type_check CHECK (type IN (
    'union_mismatch', 'channel_mismatch', 'ledger_mismatch', 'platform_restore',
    'month_end_unbalanced', 'settle_amount_mismatch', 'settle_missing', 'appeal_restore',
    'estimate_changed_after_credit'
  )),
  CONSTRAINT recon_diffs_source_check CHECK (source IN ('R1', 'R2', 'R3', 'R4')),
  CONSTRAINT recon_diffs_status_check
    CHECK (status IN ('open', 'processing', 'adjusted', 'written_off', 'closed')),
  CONSTRAINT recon_diffs_period_check
    CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12][0-9]|3[01]))?$'),
  CONSTRAINT recon_diffs_ref_type_check CHECK (ref_type <> ''),
  CONSTRAINT recon_diffs_ref_id_check CHECK (ref_id <> ''),
  CONSTRAINT recon_diffs_dedupe_key_check CHECK (dedupe_key <> ''),
  CONSTRAINT recon_diffs_resolution_check CHECK (jsonb_typeof(resolution) = 'object')
);

CREATE UNIQUE INDEX recon_diffs_dedupe_key_key
  ON app.recon_diffs (app_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX recon_diffs_month_end_key
  ON app.recon_diffs (app_id, period) WHERE type = 'month_end_unbalanced';
CREATE INDEX recon_diffs_status_idx ON app.recon_diffs (app_id, status, created_at);

CREATE TABLE app.asset_snapshots (
  id                           uuid        NOT NULL,
  app_id                       text        NOT NULL,
  snapshot_date                date        NOT NULL,
  total_available_positive_fen bigint      NOT NULL,
  total_negative_fen           bigint      NOT NULL,
  total_frozen_fen             bigint      NOT NULL,
  total_waiting_fen            bigint      NOT NULL,
  total_estimated_fen          bigint      NOT NULL,
  waiting_comparable           boolean     NOT NULL,
  created_at                   timestamptz NOT NULL,
  updated_at                   timestamptz NOT NULL,
  CONSTRAINT asset_snapshots_pkey PRIMARY KEY (id),
  CONSTRAINT asset_snapshots_day_key UNIQUE (app_id, snapshot_date),
  CONSTRAINT asset_snapshots_app_id_id_key UNIQUE (app_id, id)
);

CREATE TABLE app.asset_snapshot_receivables (
  asset_snapshot_id    uuid   NOT NULL,
  app_id               text   NOT NULL,
  platform             text   NOT NULL,
  union_receivable_fen bigint NOT NULL,
  CONSTRAINT asset_snapshot_receivables_pkey PRIMARY KEY (asset_snapshot_id, platform),
  CONSTRAINT asset_snapshot_receivables_snapshot_fkey FOREIGN KEY (app_id, asset_snapshot_id)
    REFERENCES app.asset_snapshots (app_id, id),
  CONSTRAINT asset_snapshot_receivables_platform_check CHECK (platform IN (
    'taobao', 'jd', 'pdd', 'meituan', 'vip', 'douyin', 'eleme', 'kuaishou', 'suning'
  ))
);

GRANT SELECT, INSERT ON app.recon_diffs TO couli_app;
GRANT UPDATE (status, handler_id, closed_at, dedupe_key, resolution, updated_at)
  ON app.recon_diffs TO couli_app;
GRANT SELECT, INSERT ON app.asset_snapshots TO couli_app;
GRANT UPDATE (waiting_comparable, updated_at) ON app.asset_snapshots TO couli_app;
GRANT SELECT, INSERT ON app.asset_snapshot_receivables TO couli_app;
GRANT SELECT ON app.recon_diffs, app.asset_snapshots, app.asset_snapshot_receivables
  TO couli_readonly;
