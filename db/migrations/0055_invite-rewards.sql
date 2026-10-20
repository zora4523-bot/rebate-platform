-- Up Migration
-- Invite rewards (CT-25): the eligibility and award record of an invitation and the budget
-- counters it is reserved against and paid from (规划/04 §3.2 invite_rewards, 2026-10-19; 规划/08
-- BR-INV-24 ① ④ and the daily budget clause). Task CT-25b (orchestrator ruling §9.2, §9.12; budget
-- table shape D10-94 ③). Codes are the ones of contract task CT-25a; their meaning lives only in
-- BR-INV-24. Eligibility and award decisions belong to B1-35, not to this schema.
-- Compatibility: additive. Two new ordinary tables in schema app with named constraints, two
-- indexes and grants; no existing object changes (the foreign keys only take a SHARE ROW EXCLUSIVE
-- lock on users, order_keys and ledger_vouchers while they are added).
-- Recovery: restore from backup; no down migration.
--
-- app.invite_rewards: one row per invitee (primary key (app_id, invitee_id)), written by growth in
-- the binding transaction (landing, register, backfill) while the campaign is active, then updated
-- by the award job. Rows are never deleted.
--   amount_fen: the amount locked for EACH side at qualification (bigint fen, >= 0).
--   bind_ip_hmac: keyed blind index (64 lowercase hex) of the client IP of the binding request,
--     used for the same-IP judgement; never the clear value.
--   trigger_order_id / triggered_at: the triggering order (foreign key to order_keys
--     (app_id, order_id)) and when it triggered; null until then.
--   status: qualified / deferred / processed / voided / budget_exhausted.
--   inviter_result / invitee_result: granted / skipped. Technical choice (04 lists them as
--     required): they have no value before processing, so they are nullable; status = 'processed'
--     requires both.
--   inviter_skip_reason / invitee_skip_reason: 04's single skip_reason split per side; present
--     exactly when that side's result is 'skipped' (a null result carries no reason).
--   void_reason: present exactly when status = 'voided'.
--   inviter_voucher_id / invitee_voucher_id: ledger vouchers of the payout (foreign keys to
--     ledger_vouchers (app_id, id)); granted_at: when paid.
--   row_version: optimistic version, starts at 0.
-- No column has a SQL clock default: qualified_at and the other business instants come from the
-- injected Clock.
--
-- app.invite_reward_budgets: budget counters, one row per (app_id, period); period is 'total' or a
-- +08:00 natural day 'YYYY-MM-DD' (computed by the caller with packages/domain).
--   total row: reserved_fen (qualified, not yet paid or released) and granted_fen (paid).
--   day rows: granted_fen only (the daily budget counts only what is actually paid that day);
--     reserved_fen is always 0.
-- The limits are not stored here (config growth.invite_reward.*_budget_fen). Callers deduct with a
-- conditional UPDATE in the same transaction as the qualification or payout:
-- reserved_fen + granted_fen + need <= limit (total), granted_fen + need <= limit (day); zero rows
-- updated means not enough budget. No function is defined by this migration.
--
-- Grants (one GRANT per table and role): couli_app SELECT, INSERT and column-level UPDATE on the
-- mutable columns only (identity, amount, binding source and IP, qualification time and the
-- budget key are never updatable); no DELETE, TRUNCATE, REFERENCES or TRIGGER for anyone.
-- couli_readonly SELECT.
--
-- Timeouts: two new empty tables, five foreign keys (SHARE ROW EXCLUSIVE locks on users,
-- order_keys and ledger_vouchers while they are added) and two indexes on empty tables; 5s lock
-- wait so a blocked deploy fails fast, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.invite_rewards (
  app_id               text        NOT NULL,
  invitee_id           uuid        NOT NULL,
  inviter_id           uuid        NOT NULL,
  amount_fen           bigint      NOT NULL,
  qualified_at         timestamptz NOT NULL,
  bind_source          text        NOT NULL,
  bind_ip_hmac         text        NOT NULL,
  trigger_order_id     uuid,
  triggered_at         timestamptz,
  status               text        NOT NULL,
  inviter_result       text,
  invitee_result       text,
  inviter_skip_reason  text,
  invitee_skip_reason  text,
  void_reason          text,
  inviter_voucher_id   uuid,
  invitee_voucher_id   uuid,
  granted_at           timestamptz,
  row_version          integer     NOT NULL DEFAULT 0,
  CONSTRAINT invite_rewards_pkey PRIMARY KEY (app_id, invitee_id),
  CONSTRAINT invite_rewards_invitee_fkey FOREIGN KEY (app_id, invitee_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT invite_rewards_inviter_fkey FOREIGN KEY (app_id, inviter_id)
    REFERENCES app.users (app_id, id),
  CONSTRAINT invite_rewards_trigger_order_fkey FOREIGN KEY (app_id, trigger_order_id)
    REFERENCES app.order_keys (app_id, order_id),
  CONSTRAINT invite_rewards_inviter_voucher_fkey FOREIGN KEY (app_id, inviter_voucher_id)
    REFERENCES app.ledger_vouchers (app_id, id),
  CONSTRAINT invite_rewards_invitee_voucher_fkey FOREIGN KEY (app_id, invitee_voucher_id)
    REFERENCES app.ledger_vouchers (app_id, id),
  CONSTRAINT invite_rewards_amount_fen_check CHECK (amount_fen >= 0),
  CONSTRAINT invite_rewards_bind_source_check
    CHECK (bind_source IN ('landing', 'register', 'backfill')),
  CONSTRAINT invite_rewards_bind_ip_hmac_check CHECK (bind_ip_hmac ~ '^[0-9a-f]{64}$'),
  CONSTRAINT invite_rewards_status_check
    CHECK (status IN ('qualified', 'deferred', 'processed', 'voided', 'budget_exhausted')),
  CONSTRAINT invite_rewards_inviter_result_check
    CHECK (inviter_result IN ('granted', 'skipped')),
  CONSTRAINT invite_rewards_invitee_result_check
    CHECK (invitee_result IN ('granted', 'skipped')),
  CONSTRAINT invite_rewards_inviter_skip_reason_check
    CHECK (inviter_skip_reason IN ('same_device', 'same_ip', 'deleted_phone_retained',
      'multi_account', 'risk_restricted', 'deleting', 'minor')),
  CONSTRAINT invite_rewards_invitee_skip_reason_check
    CHECK (invitee_skip_reason IN ('same_device', 'same_ip', 'deleted_phone_retained',
      'multi_account', 'risk_restricted', 'deleting', 'minor')),
  CONSTRAINT invite_rewards_void_reason_check
    CHECK (void_reason IN ('relation_changed', 'order_clawed_back', 'order_rights')),
  -- IS NOT DISTINCT FROM: a null result must not carry a reason (plain = would yield null and pass).
  CONSTRAINT invite_rewards_inviter_skip_pair_check
    CHECK ((inviter_result IS NOT DISTINCT FROM 'skipped') = (inviter_skip_reason IS NOT NULL)),
  CONSTRAINT invite_rewards_invitee_skip_pair_check
    CHECK ((invitee_result IS NOT DISTINCT FROM 'skipped') = (invitee_skip_reason IS NOT NULL)),
  CONSTRAINT invite_rewards_void_pair_check
    CHECK ((status = 'voided') = (void_reason IS NOT NULL)),
  CONSTRAINT invite_rewards_processed_results_check
    CHECK (status <> 'processed' OR (inviter_result IS NOT NULL AND invitee_result IS NOT NULL))
);

CREATE INDEX invite_rewards_inviter_idx ON app.invite_rewards (app_id, inviter_id);

CREATE INDEX invite_rewards_status_triggered_idx
  ON app.invite_rewards (app_id, status, triggered_at);

CREATE TABLE app.invite_reward_budgets (
  app_id        text        NOT NULL,
  period        text        NOT NULL,
  reserved_fen  bigint      NOT NULL DEFAULT 0,
  granted_fen   bigint      NOT NULL DEFAULT 0,
  row_version   integer     NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invite_reward_budgets_pkey PRIMARY KEY (app_id, period),
  CONSTRAINT invite_reward_budgets_period_check
    CHECK (period = 'total' OR period ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  CONSTRAINT invite_reward_budgets_reserved_fen_check CHECK (reserved_fen >= 0),
  CONSTRAINT invite_reward_budgets_granted_fen_check CHECK (granted_fen >= 0),
  CONSTRAINT invite_reward_budgets_day_reserved_check
    CHECK (period = 'total' OR reserved_fen = 0)
);

GRANT SELECT, INSERT,
  UPDATE (trigger_order_id, triggered_at, status, inviter_result, invitee_result,
    inviter_skip_reason, invitee_skip_reason, void_reason, inviter_voucher_id, invitee_voucher_id,
    granted_at, row_version)
  ON app.invite_rewards TO couli_app;
GRANT SELECT ON app.invite_rewards TO couli_readonly;

GRANT SELECT, INSERT, UPDATE (reserved_fen, granted_fen, row_version, updated_at)
  ON app.invite_reward_budgets TO couli_app;
GRANT SELECT ON app.invite_reward_budgets TO couli_readonly;
