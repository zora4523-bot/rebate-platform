-- Up Migration
-- Daily balances per account × sub-account × accounting date (BR-FUND-19 ① 期初 + 当日发生额 =
-- 期末; 规划/02 §8.4). Task B2-02d; table design follows default D9 A of
-- couli-runs/FUNDS-quote/ledger-plan.md. Written by the daily runner (B2-02j), read by the
-- daily invariant SQL.
-- Compatibility: additive. One new ordinary table with named constraints, and grants.
-- Recovery: restore from backup; no down migration.
--
-- daily_balances: one row per (app_id, account_id, sub_account, accounting_date). sub_account is
--   the same closed set as ledger_entries (available | frozen). Money columns are bigint fen:
--   opening_fen and closing_fen may be negative (available may go negative, BR-FUND-13);
--   debit_fen and credit_fen are the day's non-negative turnover. There is deliberately no CHECK
--   that opening + debit - credit = closing: that equality is what the daily invariant SQL
--   checks, and a database constraint would keep a mismatch from being recorded at all.
--   computed_at is the injected Clock time of the run (no database default, D2); a rerun of the
--   same day overwrites the row (INSERT … ON CONFLICT … DO UPDATE). (app_id, account_id)
--   references app.ledger_accounts (app_id, id), no cascade. The primary key leads with
--   (app_id, account_id), so it also serves the foreign key and per-account lookups; no extra
--   index is created.
-- Retention: none.
--
-- Grants: couli_app SELECT, INSERT, UPDATE on the whole table (rerun overwrite), no DELETE /
-- TRUNCATE. couli_readonly SELECT. couli_payout and couli_maint get nothing.
--
-- Timeouts: only a new, empty table is created; short catalog locks only (the foreign key takes
-- a SHARE ROW EXCLUSIVE lock on ledger_accounts briefly). 5s lock wait so a blocked deploy fails
-- fast, 30s overall as a ceiling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE app.daily_balances (
  app_id          text NOT NULL,
  account_id      uuid NOT NULL,
  sub_account     text NOT NULL,
  accounting_date date NOT NULL,
  opening_fen     bigint NOT NULL,
  debit_fen       bigint NOT NULL,
  credit_fen      bigint NOT NULL,
  closing_fen     bigint NOT NULL,
  computed_at     timestamptz NOT NULL,
  CONSTRAINT daily_balances_pkey
    PRIMARY KEY (app_id, account_id, sub_account, accounting_date),
  CONSTRAINT daily_balances_account_fkey FOREIGN KEY (app_id, account_id)
    REFERENCES app.ledger_accounts (app_id, id),
  CONSTRAINT daily_balances_sub_account_check CHECK (sub_account IN ('available', 'frozen')),
  CONSTRAINT daily_balances_debit_fen_check CHECK (debit_fen >= 0),
  CONSTRAINT daily_balances_credit_fen_check CHECK (credit_fen >= 0)
);

GRANT SELECT, INSERT, UPDATE ON app.daily_balances TO couli_app;
GRANT SELECT ON app.daily_balances TO couli_readonly;
