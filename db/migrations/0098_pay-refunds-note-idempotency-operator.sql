-- Up Migration
-- pay_refunds: the operator's note and the idempotency key scoped by operator (08 BR-PAY-06 ②;
-- 规划/04 §5「幂等」后台账号的幂等主体 a:<admin_user_id>, D10-168 ②; orchestrator rulings D10-350 and
-- D10-351 ②, 2026-10-25). Task B2-15e. Placeholder number: the orchestrator renumbers it to the
-- trunk's next free number when it lands (the local migrations numbering test reports the gap
-- until then, as expected).
-- Compatibility: additive on the column; the unique key only widens (every existing row stays
-- valid: a key unique per app is unique per (app, operator) too). No data change.
-- Recovery: restore from backup; no down migration.
--
-- note (D10-350): the free text the console sends with a refund (contract
--   AdminPayRefundCreateRequest.note, at most 200 characters), kept on the refund row and shown back
--   by the refund operations. Nullable: reason_code OTHER does not require one. The length limit is
--   checked by the application only (the contract schema refuses a longer value with 20001 before
--   the handler runs) — of the two choices of D10-350 this one is taken, so that a funds table
--   gets no new CHECK (a CHECK on pay_refunds would need NOT VALID plus its own validate
--   migration, precedent 0081 / 0082, for a column that is NULL on every existing row). It is
--   written by the creating INSERT only: couli_app has no UPDATE grant on it (the UPDATE grant of
--   0076 names status, channel_refund_no, succeeded_at and failed_at), so the immutable-column
--   trigger of 0076 is left as it is.
-- pay_refunds_idempotency_key_key (D10-351 ②): rebuilt under the same name as
--   UNIQUE (app_id, operator, idempotency_key). The idempotency record of a console refund is
--   scoped by the admin account (subject a:<admin_users.id>, idempotency_keys UNIQUE (app_id,
--   subject, method, path, key)); the business key must match it, otherwise two operators who
--   happen to send the same Idempotency-Key would collide on the refund row instead of each getting
--   their own record. The unique index is built first and then attached with UNIQUE USING INDEX
--   under the same name (as 0046 / 0062: pay_refunds is a funds table and takes no squawk
--   exception).
-- Guard (CT-06d): pay_refunds is a funds table (pay_ prefix); a constraint rebuilt under the same
--   name with a different definition needs this file registered by hash in APPROVED_GUARD_CHANGES
--   of tools/ci/lint-migrations.ts (orchestrator task; two reviews and the approval label). Any
--   later edit of this file needs a new registration.
--
-- Timeouts: ADD COLUMN and DROP / ADD CONSTRAINT take an ACCESS EXCLUSIVE lock on pay_refunds
-- (catalog only, no rewrite: the column has no default); the unique index build takes a SHARE
-- lock (small before launch). 5s lock wait so a blocked deploy fails fast instead of queueing
-- refunds behind it, 60s overall as a ceiling for the index build.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE app.pay_refunds ADD COLUMN note text;

ALTER TABLE app.pay_refunds DROP CONSTRAINT pay_refunds_idempotency_key_key;

CREATE UNIQUE INDEX pay_refunds_idempotency_key_key
  ON app.pay_refunds (app_id, operator, idempotency_key);

ALTER TABLE app.pay_refunds
  ADD CONSTRAINT pay_refunds_idempotency_key_key UNIQUE USING INDEX pay_refunds_idempotency_key_key;
