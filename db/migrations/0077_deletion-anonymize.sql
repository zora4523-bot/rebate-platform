-- Up Migration
-- Account-deletion anonymization, storage part two (orchestrator rulings D10-186 and D10-137 ②,
-- task B1-15r §9.2, prerequisite of B1-15g, the cleanup itself). Storage, grants and two relaxed
-- CHECK constraints: no data is moved or backfilled, no foreign key, index or column is dropped.
-- Compatibility: additive. payout_accounts gets one nullable column without a default; realname
-- gets one NOT NULL column with the constant default false (no table rewrite on PostgreSQL 11+).
-- Every INSERT that omits the new columns stays valid and every existing row stays valid: with
-- anonymized_at NULL and tax_retained false both rebuilt checks reduce to their 0009 / 0041
-- definitions. Recovery: restore from backup; no down migration.
--
-- app.payout_accounts (D10-186 ①: no DELETE, anonymize in place so withdrawals keep their
-- reference):
--   anonymized_at: when the deletion cleanup cleared the row (from the injected Clock; no SQL
--     default). NULL on every live or replaced account.
--   payout_accounts_details_check, rebuilt under the same name (CT-06c/CT-06d: a funds-table
--     constraint is only ever recreated under its own name; the changed definition needs this file
--     in APPROVED_GUARD_CHANGES of tools/ci/lint-migrations.ts, a separate guard-change task):
--       anonymized_at IS NULL: exactly the 0009 condition (method-specific fields present, the
--         other method's fields absent), unchanged for current and historical accounts;
--       anonymized_at IS NOT NULL: every identifier (alipay_logon_id_cipher, alipay_hmac,
--         bank_card_no_cipher, bank_card_hmac, card_bin) is NULL and is_current is false.
--         bank_name may stay or be cleared (it identifies a bank, not a person). An anonymized row
--         can never be current, so it never occupies the three partial unique indexes
--         (… WHERE is_current), which stay as they are. The original condition is not accepted on
--         the anonymized branch (rule tests, B1-15r §9 补): a row is either live or fully cleared.
--     payout_method keeps payout_accounts_method_check; payee_name stays NOT NULL (the cleanup
--     writes a placeholder; its text belongs to B1-15g).
--   Added NOT VALID here and validated by the next migration (0078), as 0057 / 0058 did for
--   invite_rewards: no squawk exception is accepted on a funds table.
--   Grants: couli_app gets column UPDATE on exactly the columns the cleanup writes (anonymized_at,
--     the five identifiers, bank_name, payee_name), added to the 0009 grants (is_current,
--     row_version, updated_at). No DELETE; id, app_id, user_id, payout_method and created_at stay
--     immutable for couli_app.
--   payout_accounts_anonymize_only (D10-269): the column grants above alone would let couli_app
--     rewrite the payee account of a live row, which 0009 forbade. A BEFORE UPDATE row trigger
--     (function app.payout_accounts_reject_identifier_update, same shape as 0076's
--     pay_orders_reject_immutable_update) keeps that rule in the database:
--       ① alipay_logon_id_cipher, alipay_hmac, bank_card_no_cipher, bank_card_hmac, bank_name,
--         card_bin and payee_name may differ from OLD only in the one UPDATE that anonymizes the
--         row (OLD.anonymized_at IS NULL and NEW.anonymized_at IS NOT NULL);
--       ② once anonymized_at is set it never changes again, including back to NULL.
--     is_current, row_version and updated_at keep their 0009 behaviour. 0009 to 0076 put no
--     trigger on this table, so nothing is replaced (a new guard, not a changed one).
--
-- app.realname (D10-137 ②: a member with a successful withdrawal keeps the real-name ciphertext
-- for tax purposes, read-only, and is marked; everyone else is cleared):
--   tax_retained: boolean NOT NULL DEFAULT false.
--   realname_unverified_cleared_check, rebuilt under the same name: a non-verified row must have
--     all four private columns NULL, except status 'none' with tax_retained true, which may keep
--     name_cipher / id_no_cipher / id_no_hmac / birth_date_cipher (and provider / verified_at).
--     'failed' rows get no exemption. realname_verified_check, the HMAC and provider checks and
--     the unique index on verified HMACs are unchanged, so a verified row is still complete and a
--     retained row (status none) never occupies the verified-HMAC index.
--   realname is not a funds or attribution table; the check is still added NOT VALID and validated
--   in 0078, the same two-step shape as above.
--   Grants: couli_app gets column UPDATE (tax_retained), added to the 0041 grants that already
--     cover every column the cleanup clears (the four private columns, status, provider,
--     verified_at, row_version, updated_at). couli_readonly gets nothing new.
--
-- Timeouts: ALTER TABLE takes an ACCESS EXCLUSIVE lock on each of the two tables (ADD COLUMN and
-- the constraint swaps are catalog changes; NOT VALID skips the scan), held to commit; 5s lock wait
-- so a blocked deploy fails fast instead of queueing payout and real-name writes, 30s overall.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.payout_accounts ADD COLUMN anonymized_at timestamptz;

ALTER TABLE app.payout_accounts DROP CONSTRAINT payout_accounts_details_check;

ALTER TABLE app.payout_accounts ADD CONSTRAINT payout_accounts_details_check CHECK (
  (
    anonymized_at IS NULL AND (
      (
        payout_method = 'alipay'
        AND alipay_logon_id_cipher IS NOT NULL AND alipay_hmac IS NOT NULL
        AND bank_card_no_cipher IS NULL AND bank_card_hmac IS NULL
        AND bank_name IS NULL AND card_bin IS NULL
      ) OR (
        payout_method = 'bank_card'
        AND bank_card_no_cipher IS NOT NULL AND bank_card_hmac IS NOT NULL
        AND bank_name IS NOT NULL AND card_bin IS NOT NULL
        AND alipay_logon_id_cipher IS NULL AND alipay_hmac IS NULL
      )
    )
  ) OR (
    anonymized_at IS NOT NULL
    AND alipay_logon_id_cipher IS NULL AND alipay_hmac IS NULL
    AND bank_card_no_cipher IS NULL AND bank_card_hmac IS NULL AND card_bin IS NULL
    AND NOT is_current
  )
) NOT VALID;

GRANT UPDATE (
  anonymized_at,
  alipay_logon_id_cipher,
  alipay_hmac,
  bank_card_no_cipher,
  bank_card_hmac,
  bank_name,
  card_bin,
  payee_name
) ON app.payout_accounts TO couli_app;

CREATE FUNCTION app.payout_accounts_reject_identifier_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.anonymized_at IS NOT NULL
    AND NEW.anonymized_at IS DISTINCT FROM OLD.anonymized_at
  THEN
    RAISE EXCEPTION 'payout_accounts anonymized_at cannot be changed once set'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (OLD.anonymized_at IS NULL AND NEW.anonymized_at IS NOT NULL)
    AND (
      NEW.alipay_logon_id_cipher IS DISTINCT FROM OLD.alipay_logon_id_cipher
      OR NEW.alipay_hmac IS DISTINCT FROM OLD.alipay_hmac
      OR NEW.bank_card_no_cipher IS DISTINCT FROM OLD.bank_card_no_cipher
      OR NEW.bank_card_hmac IS DISTINCT FROM OLD.bank_card_hmac
      OR NEW.bank_name IS DISTINCT FROM OLD.bank_name
      OR NEW.card_bin IS DISTINCT FROM OLD.card_bin
      OR NEW.payee_name IS DISTINCT FROM OLD.payee_name
    )
  THEN
    RAISE EXCEPTION 'payout_accounts account columns can only change in the anonymizing update'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.payout_accounts_reject_identifier_update() FROM PUBLIC;

CREATE TRIGGER payout_accounts_anonymize_only
  BEFORE UPDATE ON app.payout_accounts
  FOR EACH ROW EXECUTE FUNCTION app.payout_accounts_reject_identifier_update();

ALTER TABLE app.realname ADD COLUMN tax_retained boolean NOT NULL DEFAULT false;

ALTER TABLE app.realname DROP CONSTRAINT realname_unverified_cleared_check;

ALTER TABLE app.realname ADD CONSTRAINT realname_unverified_cleared_check CHECK (
  status = 'verified'
  OR (status = 'none' AND tax_retained)
  OR (
    name_cipher IS NULL AND id_no_cipher IS NULL AND id_no_hmac IS NULL
    AND birth_date_cipher IS NULL
  )
) NOT VALID;

GRANT UPDATE (tax_retained) ON app.realname TO couli_app;
