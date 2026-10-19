-- Up Migration
-- Backfill of the single user balance account for existing users (规划/08 BR-FUND-13: every user
-- has exactly one USER_BALANCE account and one account_balances row with available and frozen at
-- 0; ledger-plan D6 A). Task B2-02h. Since B2-02g (#934) registration opens the account inside the
-- registration transaction; users created before that have none, and this migration adds it.
-- Compatibility: data only. Two INSERT … SELECT … ON CONFLICT DO NOTHING statements; no table,
-- constraint, index, trigger or grant changes, and no existing row is touched.
-- Recovery: none needed. It only inserts missing rows and is safe to run again (a second run
-- inserts nothing); restore from backup if ever required. No down migration.
--
-- Accounts: one row per app.users row that has no (app_id, user, id, USER_BALANCE) account yet,
-- keyed by users.app_id and users.id (never across apps). Every user status is included (normal,
-- deleting, deleted, and the source side of a merge): BR-FUND-13 does not depend on status. The id
-- is gen_random_uuid(), as the application side (ledger openUserAccount, randomUUID) does;
-- created_at is the column default.
-- Balances: one zero row (available_fen 0, frozen_fen 0, version 0, negative_since NULL) for every
-- user USER_BALANCE account without one, including accounts that existed before this migration
-- but lacked the row. Platform accounts are not touched.
-- Concurrency: a registration committing during the run inserts its own account and balance in
-- its transaction; the unique keys (ledger_accounts_owner_subject_key, account_balances_pkey) make
-- the later writer skip, so no duplicate and no overwrite.
--
-- lock_timeout 5s: the INSERTs take ROW EXCLUSIVE on the two ledger tables and ACCESS SHARE on
-- users, which only conflict with DDL; give up quickly instead of queueing behind a DDL lock.
-- statement_timeout 120s: each statement is a single pass over users (or ledger_accounts) with
-- an anti-join on a unique index; ample for the current number of users.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

INSERT INTO app.ledger_accounts (id, app_id, owner_type, owner_id, subject)
SELECT gen_random_uuid(), u.app_id, 'user', u.id::text, 'USER_BALANCE'
FROM app.users AS u
WHERE NOT EXISTS (
  SELECT 1
  FROM app.ledger_accounts AS a
  WHERE a.app_id = u.app_id
    AND a.owner_type = 'user'
    AND a.owner_id = u.id::text
    AND a.subject = 'USER_BALANCE'
)
ON CONFLICT (app_id, owner_type, owner_id, subject) DO NOTHING;

INSERT INTO app.account_balances (app_id, account_id, available_fen, frozen_fen, version, negative_since)
SELECT a.app_id, a.id, 0, 0, 0, NULL
FROM app.ledger_accounts AS a
WHERE a.owner_type = 'user'
  AND a.subject = 'USER_BALANCE'
  AND NOT EXISTS (
    SELECT 1
    FROM app.account_balances AS b
    WHERE b.account_id = a.id
  )
ON CONFLICT (account_id) DO NOTHING;
