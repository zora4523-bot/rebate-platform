-- Up Migration
-- Ledger core tables (BR-FUND-13 单一余额, BR-FUND-15 流水类型, BR-FUND-16 复式记账硬约束;
-- 规划/04 §3.2 ledger_accounts, ledger_vouchers, ledger_entries, account_balances; ADR-0001 §4.2
-- #4, #5 按月分区、DEFAULT 分区兜底). Task B2-02c; column design follows the defaults D2, D3, D7,
-- D8, D11, D15 of couli-runs/FUNDS-quote/ledger-plan.md §3 (orchestrator decisions 16, 17).
-- Compatibility: additive. Three ordinary tables, one month-partitioned table with its DEFAULT
-- partition, named constraints / indexes, two append-only guard triggers, grants, and CREATE OR
-- REPLACE of app.ensure_month_partition that only extends its allow-list.
-- Recovery: restore from backup; no down migration.
--
-- Common: every table has app_id text NOT NULL; foreign keys carry app_id (no cross-app rows),
-- reference ordinary tables only, are named and never cascade. Money columns are bigint fen.
-- Business times (booked_at, accounting_date) come from the injected Clock, read once per
-- transaction, and have no database default (D2); created_at defaults to now() only as the
-- technical insert time.
--
-- ledger_accounts: one row per (app_id, owner_type, owner_id, subject) (BR-FUND-13). A user has
--   exactly one account, owner_type 'user', owner_id = user id, subject 'USER_BALANCE' (no
--   self / promo split). Platform accounts (D7) are owner_type 'platform', owner_id 'platform',
--   subject any non-user subject, optionally with a platform suffix (UNION_RECEIVABLE:taobao).
--   UNIQUE (app_id, id) is the target of the app-scoped foreign keys.
-- ledger_vouchers: one voucher per uniq_key, unique exactly on (app_id, uniq_key) (BR-FUND-16);
--   corrections are new vouchers (`{uniq_key}:REVERSE`). order_key, beneficiary_user_id, role and
--   voucher_kind are nullable structured metadata for the invariants (D3); they are not checked
--   against uniq_key (decision 17). Insert-only.
-- ledger_entries: signed amount_fen (debit +, credit -, never 0) on the available or frozen
--   sub-account; ledger_type is the closed set of 13 values (BR-FUND-15, contracts/enums/fund.yaml),
--   sub_type refines it; income_type is NULL or SERVICE_FEE / INCIDENTAL (D15). balance_after_fen
--   and account_version (the account_balances.version after the write, D11) are written for user
--   account entries only and are both NULL or both set. Partitioned by RANGE (booked_at), so the
--   primary key is (id, booked_at). Only the DEFAULT partition is created here; month partitions
--   are created at runtime by app.ensure_month_partition (pnpm db:partitions). Insert-only; the
--   row triggers on the parent are cloned to every partition. Σ amount_fen = 0 per voucher is
--   checked by the domain layer and the daily SQL review, not here.
-- account_balances: balance cache, one row per account (primary key account_id), updated in the
--   same transaction as the entries after SELECT … FOR UPDATE. available_fen may be negative;
--   frozen_fen >= 0; version >= 0; negative_since is the accounting date it went negative.
-- Retention: none. Ledger partitions are never dropped (drop_expired_month_partitions keeps
-- rejecting ledger_entries).
--
-- Grants (D8): couli_app SELECT, INSERT on ledger_accounts, ledger_vouchers, ledger_entries;
-- SELECT, INSERT on account_balances and UPDATE only on available_fen, frozen_fen,
-- negative_since, version. No UPDATE / DELETE / TRUNCATE on the three insert-only tables for
-- anyone; app.reject_update_delete() triggers (0003) reject UPDATE and DELETE on vouchers and
-- entries for every role as a second line of defence. couli_readonly SELECT. couli_payout and
-- couli_maint get nothing (couli_maint only reaches ledger_entries through the SECURITY DEFINER
-- ensure_month_partition). Partitions get no grants of their own.
--
-- Timeouts: only new, empty tables are created and one function is replaced; short catalog
-- locks only. 5s lock wait so a blocked deploy fails fast, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.ledger_accounts (
  id         uuid NOT NULL,
  app_id     text NOT NULL,
  owner_type text NOT NULL,
  owner_id   text NOT NULL,
  subject    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT ledger_accounts_app_id_id_key UNIQUE (app_id, id),
  CONSTRAINT ledger_accounts_owner_subject_key UNIQUE (app_id, owner_type, owner_id, subject),
  CONSTRAINT ledger_accounts_owner_type_check CHECK (owner_type IN ('user', 'platform')),
  CONSTRAINT ledger_accounts_owner_id_check CHECK (owner_id <> ''),
  CONSTRAINT ledger_accounts_subject_check CHECK (
    (owner_type = 'user' AND subject = 'USER_BALANCE')
    OR (owner_type = 'platform' AND owner_id = 'platform'
      AND subject <> '' AND subject <> 'USER_BALANCE')
  )
);

CREATE TABLE app.ledger_vouchers (
  id                  uuid NOT NULL,
  app_id              text NOT NULL,
  biz_type            text NOT NULL,
  biz_id              text NOT NULL,
  uniq_key            text NOT NULL,
  accounting_date     date NOT NULL,
  operator            text NOT NULL,
  memo                text,
  order_key           text,
  beneficiary_user_id uuid,
  role                text,
  voucher_kind        text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_vouchers_pkey PRIMARY KEY (id),
  CONSTRAINT ledger_vouchers_app_id_id_key UNIQUE (app_id, id),
  CONSTRAINT ledger_vouchers_uniq_key_key UNIQUE (app_id, uniq_key),
  CONSTRAINT ledger_vouchers_uniq_key_check CHECK (uniq_key <> ''),
  CONSTRAINT ledger_vouchers_biz_type_check CHECK (biz_type <> '')
);

CREATE INDEX ledger_vouchers_accounting_date_idx
  ON app.ledger_vouchers (app_id, accounting_date);
CREATE INDEX ledger_vouchers_order_key_idx
  ON app.ledger_vouchers (app_id, order_key) WHERE order_key IS NOT NULL;

CREATE TRIGGER ledger_vouchers_append_only
  BEFORE UPDATE OR DELETE ON app.ledger_vouchers
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

CREATE TABLE app.ledger_entries (
  id                bigint GENERATED ALWAYS AS IDENTITY,
  app_id            text NOT NULL,
  voucher_id        uuid NOT NULL,
  account_id        uuid NOT NULL,
  sub_account       text NOT NULL,
  amount_fen        bigint NOT NULL,
  ledger_type       text NOT NULL,
  sub_type          text,
  income_type       text,
  balance_after_fen bigint,
  account_version   bigint,
  booked_at         timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_entries_pkey PRIMARY KEY (id, booked_at),
  CONSTRAINT ledger_entries_voucher_fkey FOREIGN KEY (app_id, voucher_id)
    REFERENCES app.ledger_vouchers (app_id, id),
  CONSTRAINT ledger_entries_account_fkey FOREIGN KEY (app_id, account_id)
    REFERENCES app.ledger_accounts (app_id, id),
  CONSTRAINT ledger_entries_sub_account_check CHECK (sub_account IN ('available', 'frozen')),
  CONSTRAINT ledger_entries_amount_fen_check CHECK (amount_fen <> 0),
  CONSTRAINT ledger_entries_ledger_type_check CHECK (ledger_type IN (
    'REBATE_CREDIT', 'SHARE_CREDIT', 'REFERRAL_CREDIT', 'CLAWBACK', 'SETTLE_ADJUST',
    'WITHDRAW_FREEZE', 'WITHDRAW_PAID', 'WITHDRAW_RETURN', 'WITHDRAW_FEE', 'TAX_WITHHOLD',
    'REWARD', 'ADMIN_ADJUST', 'BAD_DEBT_WRITEOFF'
  )),
  CONSTRAINT ledger_entries_sub_type_check CHECK (sub_type <> ''),
  CONSTRAINT ledger_entries_income_type_check
    CHECK (income_type IN ('SERVICE_FEE', 'INCIDENTAL')),
  CONSTRAINT ledger_entries_balance_after_check
    CHECK ((balance_after_fen IS NULL) = (account_version IS NULL)),
  CONSTRAINT ledger_entries_account_version_check CHECK (account_version >= 1)
) PARTITION BY RANGE (booked_at);

CREATE TABLE app.ledger_entries_default PARTITION OF app.ledger_entries DEFAULT;

CREATE INDEX ledger_entries_voucher_idx ON app.ledger_entries (app_id, voucher_id);
CREATE INDEX ledger_entries_account_booked_idx
  ON app.ledger_entries (app_id, account_id, booked_at DESC);
CREATE INDEX ledger_entries_account_version_idx
  ON app.ledger_entries (account_id, account_version) WHERE account_version IS NOT NULL;

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON app.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.reject_update_delete();

CREATE TABLE app.account_balances (
  app_id         text NOT NULL,
  account_id     uuid NOT NULL,
  available_fen  bigint NOT NULL,
  frozen_fen     bigint NOT NULL,
  negative_since date,
  version        bigint NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_balances_pkey PRIMARY KEY (account_id),
  CONSTRAINT account_balances_account_fkey FOREIGN KEY (app_id, account_id)
    REFERENCES app.ledger_accounts (app_id, id),
  CONSTRAINT account_balances_frozen_fen_check CHECK (frozen_fen >= 0),
  CONSTRAINT account_balances_version_check CHECK (version >= 0)
);

GRANT SELECT, INSERT ON app.ledger_accounts TO couli_app;
GRANT SELECT, INSERT ON app.ledger_vouchers TO couli_app;
GRANT SELECT, INSERT ON app.ledger_entries TO couli_app;
GRANT SELECT, INSERT ON app.account_balances TO couli_app;
GRANT UPDATE (available_fen, frozen_fen, negative_since, version)
  ON app.account_balances TO couli_app;
GRANT SELECT ON app.ledger_accounts, app.ledger_vouchers, app.ledger_entries,
  app.account_balances TO couli_readonly;

-- Keep the existing function (0030) unchanged: UTC boundaries, advisory lock, safe search_path
-- and role boundary. Only its allow-list gains ledger_entries (db/AGENTS.md rule 5; mirrored by
-- MONTH_PARTITIONED_TABLES in packages/db/src/partitions.ts).
CREATE OR REPLACE FUNCTION app.ensure_month_partition(p_table text, p_month date)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_start  date;
  v_end    date;
  v_name   text;
  v_parent oid;
  v_child  oid;
BEGIN
  IF p_table IS NULL OR p_month IS NULL THEN
    RAISE EXCEPTION 'ensure_month_partition: p_table and p_month are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Allow-list of month-partitioned tables (ADR-0001 §4.2 #5). Extend it in the migration
  -- that creates the next partitioned table.
  IF p_table NOT IN ('event_log', 'orders', 'union_raw_payloads', 'price_snapshot', 'ledger_entries') THEN
    RAISE EXCEPTION 'ensure_month_partition: table "%" is not month-partitioned', p_table
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- date -> timestamp (without time zone) casts keep every step independent of the session
  -- time zone.
  v_start := make_date(extract(year FROM p_month)::int, extract(month FROM p_month)::int, 1);
  v_end   := (v_start + interval '1 month')::date;
  v_name  := p_table || '_p' || to_char(v_start::timestamp, 'YYYYMM');

  -- Serialise concurrent callers for the same partition.
  PERFORM pg_advisory_xact_lock(hashtextextended('app.ensure_month_partition:' || v_name, 0));

  SELECT c.oid INTO v_parent
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = p_table AND c.relkind = 'p';
  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'ensure_month_partition: app.% is not a partitioned table', p_table
      USING ERRCODE = 'undefined_table';
  END IF;

  SELECT c.oid INTO v_child
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relname = v_name;
  IF v_child IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM pg_inherits i WHERE i.inhrelid = v_child AND i.inhparent = v_parent
    ) THEN
      RETURN v_name;
    END IF;
    RAISE EXCEPTION 'ensure_month_partition: app.% exists but is not a partition of app.%',
      v_name, p_table
      USING ERRCODE = 'duplicate_table';
  END IF;

  EXECUTE format(
    'CREATE TABLE app.%I PARTITION OF app.%I FOR VALUES FROM (%L) TO (%L)',
    v_name,
    p_table,
    to_char(v_start::timestamp, 'YYYY-MM-DD') || ' 00:00:00+00',
    to_char(v_end::timestamp, 'YYYY-MM-DD') || ' 00:00:00+00'
  );

  RETURN v_name;
END
$$;

REVOKE ALL ON FUNCTION app.ensure_month_partition(text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ensure_month_partition(text, date) TO couli_maint;
