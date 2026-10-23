-- Up Migration
-- Withdrawal core tables: withdrawals (提现单) and withdraw_holds (提现冻结记录).
-- 规划/04 §3.2 rows withdrawals, withdraw_holds; §2.4 enums (contracts/enums/fund.yaml
-- withdrawal_status, withdraw_reject_reason, withdrawal_hold_reason, withdrawal_blocked_reason,
-- withdrawal_manual_resolution, withdraw_hold_kind, withdrawal_review_mode, payout_method,
-- withdrawal_channel_state); 规划/08 BR-WDR-05 (holds), BR-WDR-07 (out_biz_no fixed, payee
-- snapshot, net_fen = amount − fee − tax), BR-WDR-08 (seven states, CAS by row_version),
-- BR-WDR-04 (count indexes by user and by payee HMAC). Task B2-05b (withdraw lane).
-- Compatibility: additive. Two new ordinary tables in schema app with named constraints and
-- indexes, one trigger (reject UPDATE of out_biz_no, app.reject_update_delete of 0003) and grants;
-- no existing object changes (the foreign keys take a SHARE ROW EXCLUSIVE lock on users while
-- they are added).
-- Recovery: restore from backup; no down migration.
--
-- withdrawals: one row per withdrawal. Money columns bigint fen; net_fen = amount_fen − fee_fen −
--   tax_fen is a CHECK (BR-WDR-07 ⑤); income_type is always SERVICE_FEE (BR-WDR-20). The payee
--   snapshot (payout_method, normalised payee_name, payee_account_cipher = the logon id / card
--   number / openid cipher, payee_hmac, bank_name for bank cards, wechat_app_id for wechat) is
--   fixed at creation and never updated (BR-WDR-02 ⑤). status: withdrawal_status; transitions go
--   through the generated transitionWithdrawal() with a CAS on status and row_version (BR-WDR-08);
--   the CHECKs below only keep each row's fields consistent with its state. out_biz_no: ASCII
--   letters and digits, at most 32, unique per app and refused on any UPDATE of the column by trigger
--   (BR-WDR-07; unconditional, the same value included). needs_manual only on PAYING or a terminal
--   row (BR-WDR-08: set at T+24h in PAYING, kept through W10).
--   review_mode / auto_decision / review_deadline: BR-WDR-30 / BR-WDR-26; reviewer, rejection,
--   execution, manual-resolution, hold and blocked columns as 04 lists them; batch_id has no foreign
--   key yet (payout_batches arrives with B2-06). channel_state / confirm_deadline /
--   wechat_launch_cipher: wechat only (BR-WDR-33). created_at is the business instant the
--   application writes from the injected Clock (BR-WDR-04 counts by it); the default is a fallback.
-- withdraw_holds: the only record of a withdrawal freeze (BR-WDR-05): several reasons may stack,
--   each released on its own; a row is in effect while released_at is null and hold_until is null
--   or in the future (judged by the application on its Clock; no derived column).
-- Retention: none (financial records are kept).
--
-- Grants (least privilege): couli_app SELECT, INSERT on both; UPDATE on withdrawals only of the
-- review / hold / block columns the api and worker entries change and of the manual-resolution
-- columns the admin entry writes (W8 offline entry, W10 unknown-outcome resolution, W11 proven
-- success write-off run on couli_app), on withdraw_holds only of released_at / released_by. couli_payout SELECT on both; UPDATE on withdrawals only of the payout
-- columns (status, attempts' outcome, manual resolution, channel fields, hold, execution); no
-- INSERT. Nobody updates the money columns, user_id, the payee snapshot, out_biz_no or created_at;
-- no DELETE, TRUNCATE, REFERENCES or TRIGGER for anyone. couli_readonly SELECT.
--
-- Timeouts: two new empty tables, their indexes and one trigger; short catalog locks only (plus
-- SHARE ROW EXCLUSIVE on users for the foreign keys). 5s lock wait so a blocked deploy fails fast,
-- 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.withdrawals (
  id                    uuid        NOT NULL,
  app_id                text        NOT NULL,
  user_id               uuid        NOT NULL,
  amount_fen            bigint      NOT NULL,
  fee_fen               bigint      NOT NULL,
  tax_fen               bigint      NOT NULL,
  net_fen               bigint      NOT NULL,
  income_type           text        NOT NULL,
  fee_rule_id           uuid,
  tax_rule_version      text,
  payout_method         text        NOT NULL,
  payee_name            text        NOT NULL,
  payee_account_cipher  bytea       NOT NULL,
  payee_hmac            text        NOT NULL,
  bank_name             text,
  wechat_app_id         text,
  channel_state         text,
  confirm_deadline      timestamptz,
  wechat_launch_cipher  bytea,
  status                text        NOT NULL,
  out_biz_no            text        NOT NULL,
  review_mode           text,
  auto_decision         jsonb,
  review_deadline       timestamptz,
  reviewer_id           uuid,
  reviewed_at           timestamptz,
  reject_reason_code    text,
  reject_note           text,
  fail_code             text,
  executor_id           uuid,
  executed_at           timestamptz,
  batch_id              uuid,
  execute_seq           integer     NOT NULL DEFAULT 0,
  needs_manual          boolean     NOT NULL DEFAULT false,
  manual_resolution     text,
  resolver_ids          jsonb,
  proof_file            text,
  manual_entry_by       uuid,
  manual_confirm_by     uuid,
  hold_reason           text,
  hold_at               timestamptz,
  blocked_reason        text,
  risk_flags            jsonb,
  risk_flags_at         timestamptz,
  payout_channel        text        NOT NULL,
  paid_at               timestamptz,
  channel_order_id      text,
  row_version           integer     NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT withdrawals_pkey PRIMARY KEY (id),
  CONSTRAINT withdrawals_app_id_id_key UNIQUE (app_id, id),
  CONSTRAINT withdrawals_out_biz_no_key UNIQUE (app_id, out_biz_no),
  CONSTRAINT withdrawals_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users (app_id, id),
  CONSTRAINT withdrawals_amount_check CHECK (amount_fen > 0),
  CONSTRAINT withdrawals_fee_check CHECK (fee_fen >= 0),
  CONSTRAINT withdrawals_tax_check CHECK (tax_fen >= 0),
  CONSTRAINT withdrawals_net_check CHECK (net_fen >= 0 AND net_fen = amount_fen - fee_fen - tax_fen),
  CONSTRAINT withdrawals_income_type_check CHECK (income_type = 'SERVICE_FEE'),
  CONSTRAINT withdrawals_payout_method_check
    CHECK (payout_method IN ('alipay', 'bank_card', 'wechat')),
  CONSTRAINT withdrawals_payout_channel_check
    CHECK (payout_channel IN ('alipay', 'bank_card', 'wechat')),
  CONSTRAINT withdrawals_payee_name_check CHECK (payee_name <> ''),
  CONSTRAINT withdrawals_payee_hmac_check CHECK (payee_hmac <> ''),
  CONSTRAINT withdrawals_bank_name_check
    CHECK ((payout_method = 'bank_card') = (bank_name IS NOT NULL)),
  CONSTRAINT withdrawals_wechat_app_id_check
    CHECK ((payout_method = 'wechat') = (wechat_app_id IS NOT NULL)),
  CONSTRAINT withdrawals_channel_state_check
    CHECK (channel_state IS NULL OR channel_state IN ('processing', 'wait_user_confirm', 'canceling')),
  CONSTRAINT withdrawals_wechat_only_check
    CHECK (payout_method = 'wechat' OR (channel_state IS NULL AND confirm_deadline IS NULL AND wechat_launch_cipher IS NULL)),
  CONSTRAINT withdrawals_status_check
    CHECK (status IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PAYING', 'PAID_API', 'PAID_MANUAL', 'FAILED')),
  CONSTRAINT withdrawals_out_biz_no_check CHECK (out_biz_no ~ '^[A-Za-z0-9]{1,32}$'),
  CONSTRAINT withdrawals_review_mode_check
    CHECK (review_mode IS NULL OR review_mode IN ('auto', 'manual')),
  CONSTRAINT withdrawals_auto_decision_check
    CHECK (auto_decision IS NULL OR jsonb_typeof(auto_decision) = 'object'),
  CONSTRAINT withdrawals_reject_reason_check
    CHECK (reject_reason_code IS NULL OR reject_reason_code IN ('RISK_SUSPECT', 'ORDER_ABNORMAL', 'PAYEE_INFO_INVALID', 'USER_REQUEST', 'OTHER', 'NEGATIVE_BALANCE')),
  CONSTRAINT withdrawals_rejected_check
    CHECK (status <> 'REJECTED' OR reject_reason_code IS NOT NULL),
  CONSTRAINT withdrawals_paid_check
    CHECK (status NOT IN ('PAID_API', 'PAID_MANUAL') OR paid_at IS NOT NULL),
  CONSTRAINT withdrawals_paid_manual_check
    CHECK (status <> 'PAID_MANUAL' OR (manual_entry_by IS NOT NULL AND manual_confirm_by IS NOT NULL)),
  CONSTRAINT withdrawals_execute_seq_check CHECK (execute_seq >= 0),
  CONSTRAINT withdrawals_needs_manual_check
    CHECK (NOT needs_manual OR status IN ('PAYING', 'REJECTED', 'PAID_API', 'PAID_MANUAL', 'FAILED')),
  CONSTRAINT withdrawals_manual_resolution_check
    CHECK (manual_resolution IS NULL OR manual_resolution IN ('paid', 'failed')),
  CONSTRAINT withdrawals_resolver_ids_check
    CHECK (resolver_ids IS NULL OR jsonb_typeof(resolver_ids) = 'array'),
  CONSTRAINT withdrawals_hold_reason_check
    CHECK (hold_reason IS NULL OR hold_reason IN ('payout_disabled', 'queue_paused', 'channel_disabled', 'member_blocked', 'single_cap', 'daily_cap', 'payer_side_after_transfer')),
  CONSTRAINT withdrawals_hold_at_check CHECK ((hold_reason IS NULL) = (hold_at IS NULL)),
  CONSTRAINT withdrawals_blocked_reason_check
    CHECK (blocked_reason IS NULL OR blocked_reason = 'NEGATIVE_BALANCE'),
  CONSTRAINT withdrawals_risk_flags_check
    CHECK (risk_flags IS NULL OR jsonb_typeof(risk_flags) = 'array'),
  CONSTRAINT withdrawals_channel_order_id_check
    CHECK (channel_order_id IS NULL OR channel_order_id <> ''),
  CONSTRAINT withdrawals_row_version_check CHECK (row_version >= 0)
);

CREATE INDEX withdrawals_user_created_idx ON app.withdrawals (app_id, user_id, created_at);
CREATE INDEX withdrawals_payee_created_idx ON app.withdrawals (app_id, payee_hmac, created_at);
CREATE INDEX withdrawals_open_idx ON app.withdrawals (app_id, user_id)
  WHERE status IN ('PENDING_REVIEW', 'APPROVED', 'PAYING');
CREATE UNIQUE INDEX withdrawals_channel_order_id_key ON app.withdrawals (app_id, channel_order_id)
  WHERE channel_order_id IS NOT NULL;

-- BR-WDR-07: out_biz_no is generated at insert and never changed (the trigger only refuses).
CREATE TRIGGER withdrawals_out_biz_no_fixed
  BEFORE UPDATE OF out_biz_no ON app.withdrawals
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

CREATE TABLE app.withdraw_holds (
  id           uuid        NOT NULL,
  app_id       text        NOT NULL,
  user_id      uuid        NOT NULL,
  reason       text        NOT NULL,
  source_ref   text,
  created_by   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  hold_until   timestamptz,
  released_at  timestamptz,
  released_by  text,
  CONSTRAINT withdraw_holds_pkey PRIMARY KEY (id),
  CONSTRAINT withdraw_holds_user_fkey FOREIGN KEY (app_id, user_id) REFERENCES app.users (app_id, id),
  CONSTRAINT withdraw_holds_reason_check
    CHECK (reason IN ('manual', 'recon_diff', 'ledger_mismatch', 'manual_failed_watch')),
  CONSTRAINT withdraw_holds_created_by_check CHECK (created_by <> ''),
  CONSTRAINT withdraw_holds_released_check CHECK ((released_at IS NULL) = (released_by IS NULL))
);

CREATE INDEX withdraw_holds_active_idx ON app.withdraw_holds (app_id, user_id)
  WHERE released_at IS NULL;

GRANT SELECT, INSERT ON app.withdrawals TO couli_app;
GRANT UPDATE (status, review_mode, auto_decision, review_deadline, reviewer_id, reviewed_at,
  reject_reason_code, reject_note, blocked_reason, hold_reason, hold_at, executor_id, executed_at,
  batch_id, execute_seq, risk_flags, risk_flags_at, paid_at, channel_order_id, fail_code,
  manual_resolution, resolver_ids, proof_file, manual_entry_by, manual_confirm_by, row_version,
  updated_at)
  ON app.withdrawals TO couli_app;
GRANT SELECT ON app.withdrawals TO couli_payout;
GRANT UPDATE (status, needs_manual, manual_resolution, resolver_ids, proof_file, manual_entry_by,
  manual_confirm_by, fail_code, paid_at, channel_order_id, channel_state, confirm_deadline,
  wechat_launch_cipher, hold_reason, hold_at, executor_id, executed_at, batch_id, execute_seq,
  row_version, updated_at)
  ON app.withdrawals TO couli_payout;
GRANT SELECT ON app.withdrawals TO couli_readonly;

GRANT SELECT, INSERT ON app.withdraw_holds TO couli_app;
GRANT UPDATE (released_at, released_by) ON app.withdraw_holds TO couli_app;
GRANT SELECT ON app.withdraw_holds TO couli_payout;
GRANT SELECT ON app.withdraw_holds TO couli_readonly;
