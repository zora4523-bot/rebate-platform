-- Up Migration
-- Commission snapshot storage (08 BR-CALC-02 / 10 / 13 / 27 at SPEC_REF 038229e; ADR-0001 §4).
-- Task B2-01g. Only the four tables and their grants; the snapshot writer is B2-03g.
-- Compatibility: additive. Four new tables in schema app; no existing object changes. Recovery:
-- restore from backup; no down migration.
--
-- commission_splits: one snapshot per order (primary key order_id, written once; a replayed order
-- event cannot rebuild it). rule_version_id, order_type, activity_type, rebate_mode, reserve_bp
-- and the beneficiaries (user_id, role, ratio_bp, level, initial_status, forfeit_reason) never
-- change (BR-CALC-10). raw_n_fen is the union value as received and may be negative;
-- reserve_fen, tlj_deduct_fen, base_fen (B) and platform_retain_fen are ≥ 0 and
-- platform_retain_fen = base_fen − Σ user shares ≤ base_fen (BR-CALC-02). beneficiaries is a
-- non-empty JSON array; the element fields are validated by the application. activity_type is
-- open text (no vocabulary is fixed yet).
-- commission_split_amounts: one row per (order, commission_version, user, role); a new version
-- is new rows, history is never overwritten; 0 ≤ amount_fen ≤ base_fen.
-- commission_split_beneficiary_events: append-only beneficiary status history (active / held /
-- forfeited, reason such as banned / deleted / minor). event_seq orders the history: "current
-- status = last event" is read by event_seq, not created_at, so two events in one instant or a
-- skewed clock cannot reorder it. user_id has no FK: a snapshot may name a beneficiary who no
-- longer exists (BR-CALC-13 forfeits that share).
-- commission_split_totals: the four amounts per (order, commission_version) (BR-CALC-27):
-- pre_base_deduct_fen = n_total_fen − base_fen; 0 ≤ user_share_total_fen ≤ base_fen;
-- tlj_redpacket_fen ≥ 0 or NULL; tlj_redpacket_fen and platform_est_profit_fen are NULL together
-- (red packet not matched, report shows 待核) and otherwise
-- platform_est_profit_fen = n_total_fen − user_share_total_fen − tlj_redpacket_fen (may be < 0).
-- The NULL pairing is spelled out as two explicit branches: a bare equality would evaluate to NULL
-- when only one side is NULL, and a CHECK lets NULL through.
--
-- Every table references app.order_keys (app_id, order_id), never the partitioned app.orders;
-- the snapshot also references app.commission_rule_versions (app_id, rule_version_id), so no row
-- can hang off another app's order or rule version. Foreign keys do not cascade (db/AGENTS.md
-- rule 7). Amounts and totals do not reference the snapshot row so that their writers stay
-- independent; the B2-03g writer inserts all of them in one transaction.
-- Each table gets the BEFORE UPDATE OR DELETE append-only trigger (rule 8), on top of the grants.
--
-- Grants: couli_app gets SELECT and INSERT only (no UPDATE / DELETE: append-only);
-- couli_readonly gets SELECT; couli_payout and couli_maint get nothing.
--
-- Timeouts: only new, empty tables are created; the only locks on existing tables are the brief
-- SHARE ROW EXCLUSIVE locks on app.order_keys and app.commission_rule_versions for the new foreign
-- keys. 5s lock wait so a blocked deploy fails fast instead of queueing order traffic behind it;
-- 30s overall as a ceiling for catalog changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.commission_splits (
  order_id               uuid NOT NULL,
  app_id                 text NOT NULL,
  rule_version_id        uuid NOT NULL,
  order_type             text NOT NULL,
  activity_type          text,
  rebate_mode            text,
  paid_at                timestamptz NOT NULL,
  paid_at_source         text NOT NULL,
  raw_n_fen              bigint NOT NULL,
  subsidy_commission_fen bigint NOT NULL,
  reserve_bp             smallint NOT NULL,
  reserve_fen            bigint NOT NULL,
  tlj_deduct_fen         bigint NOT NULL,
  base_fen               bigint NOT NULL,
  platform_retain_fen    bigint NOT NULL,
  beneficiaries          jsonb NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_splits_pkey PRIMARY KEY (order_id),
  CONSTRAINT commission_splits_order_type_check CHECK (order_type IN ('self', 'share')),
  CONSTRAINT commission_splits_rebate_mode_check CHECK (rebate_mode IN ('none', 'normal')),
  CONSTRAINT commission_splits_paid_at_source_check
    CHECK (paid_at_source IN ('platform', 'platform_modified', 'observed')),
  CONSTRAINT commission_splits_reserve_bp_check CHECK (reserve_bp BETWEEN 0 AND 10000),
  CONSTRAINT commission_splits_reserve_fen_check CHECK (reserve_fen >= 0),
  CONSTRAINT commission_splits_tlj_deduct_fen_check CHECK (tlj_deduct_fen >= 0),
  CONSTRAINT commission_splits_base_fen_check CHECK (base_fen >= 0),
  CONSTRAINT commission_splits_platform_retain_fen_check
    CHECK (platform_retain_fen >= 0 AND platform_retain_fen <= base_fen),
  CONSTRAINT commission_splits_beneficiaries_check
    CHECK (jsonb_typeof(beneficiaries) = 'array' AND beneficiaries <> '[]'::jsonb),
  CONSTRAINT commission_splits_order_fkey FOREIGN KEY (app_id, order_id)
    REFERENCES app.order_keys (app_id, order_id),
  CONSTRAINT commission_splits_rule_version_id_fkey FOREIGN KEY (app_id, rule_version_id)
    REFERENCES app.commission_rule_versions (app_id, rule_version_id)
);

CREATE TABLE app.commission_split_amounts (
  app_id             text NOT NULL,
  order_id           uuid NOT NULL,
  commission_version integer NOT NULL,
  user_id            uuid NOT NULL,
  role               text NOT NULL,
  base_fen           bigint NOT NULL,
  amount_fen         bigint NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_split_amounts_pkey
    PRIMARY KEY (app_id, order_id, commission_version, user_id, role),
  CONSTRAINT commission_split_amounts_commission_version_check CHECK (commission_version >= 1),
  CONSTRAINT commission_split_amounts_role_check
    CHECK (role IN ('self', 'share', 'direct', 'indirect')),
  CONSTRAINT commission_split_amounts_base_fen_check CHECK (base_fen >= 0),
  CONSTRAINT commission_split_amounts_amount_fen_check
    CHECK (amount_fen >= 0 AND amount_fen <= base_fen),
  CONSTRAINT commission_split_amounts_order_fkey FOREIGN KEY (app_id, order_id)
    REFERENCES app.order_keys (app_id, order_id)
);

CREATE TABLE app.commission_split_beneficiary_events (
  event_seq  bigint GENERATED ALWAYS AS IDENTITY,
  app_id     text NOT NULL,
  order_id   uuid NOT NULL,
  user_id    uuid NOT NULL,
  role       text NOT NULL,
  status     text NOT NULL,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_split_beneficiary_events_pkey PRIMARY KEY (event_seq),
  CONSTRAINT commission_split_beneficiary_events_role_check
    CHECK (role IN ('self', 'share', 'direct', 'indirect')),
  CONSTRAINT commission_split_beneficiary_events_status_check
    CHECK (status IN ('active', 'held', 'forfeited')),
  CONSTRAINT commission_split_beneficiary_events_order_fkey FOREIGN KEY (app_id, order_id)
    REFERENCES app.order_keys (app_id, order_id)
);

-- "Current status of a beneficiary" = the row with the greatest event_seq for this key.
CREATE INDEX commission_split_beneficiary_events_current_idx
  ON app.commission_split_beneficiary_events (app_id, order_id, user_id, role, event_seq);

CREATE TABLE app.commission_split_totals (
  app_id                  text NOT NULL,
  order_id                uuid NOT NULL,
  commission_version      integer NOT NULL,
  n_total_fen             bigint NOT NULL,
  pre_base_deduct_fen     bigint NOT NULL,
  base_fen                bigint NOT NULL,
  user_share_total_fen    bigint NOT NULL,
  tlj_redpacket_fen       bigint,
  platform_est_profit_fen bigint,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_split_totals_pkey PRIMARY KEY (app_id, order_id, commission_version),
  CONSTRAINT commission_split_totals_commission_version_check CHECK (commission_version >= 1),
  CONSTRAINT commission_split_totals_base_fen_check CHECK (base_fen >= 0),
  CONSTRAINT commission_split_totals_pre_base_deduct_fen_check
    CHECK (pre_base_deduct_fen = n_total_fen - base_fen),
  CONSTRAINT commission_split_totals_user_share_total_fen_check
    CHECK (user_share_total_fen >= 0 AND user_share_total_fen <= base_fen),
  CONSTRAINT commission_split_totals_tlj_redpacket_fen_check
    CHECK (tlj_redpacket_fen IS NULL OR tlj_redpacket_fen >= 0),
  CONSTRAINT commission_split_totals_platform_est_profit_fen_check
    CHECK (
      (tlj_redpacket_fen IS NULL AND platform_est_profit_fen IS NULL)
      OR (
        tlj_redpacket_fen IS NOT NULL
        AND platform_est_profit_fen IS NOT NULL
        AND platform_est_profit_fen = n_total_fen - user_share_total_fen - tlj_redpacket_fen
      )
    ),
  CONSTRAINT commission_split_totals_order_fkey FOREIGN KEY (app_id, order_id)
    REFERENCES app.order_keys (app_id, order_id)
);

CREATE TRIGGER commission_splits_append_only
  BEFORE UPDATE OR DELETE ON app.commission_splits
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();
CREATE TRIGGER commission_split_amounts_append_only
  BEFORE UPDATE OR DELETE ON app.commission_split_amounts
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();
CREATE TRIGGER commission_split_beneficiary_events_append_only
  BEFORE UPDATE OR DELETE ON app.commission_split_beneficiary_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();
CREATE TRIGGER commission_split_totals_append_only
  BEFORE UPDATE OR DELETE ON app.commission_split_totals
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

GRANT SELECT, INSERT
  ON app.commission_splits, app.commission_split_amounts,
    app.commission_split_beneficiary_events, app.commission_split_totals
  TO couli_app;

GRANT SELECT
  ON app.commission_splits, app.commission_split_amounts,
    app.commission_split_beneficiary_events, app.commission_split_totals
  TO couli_readonly;
