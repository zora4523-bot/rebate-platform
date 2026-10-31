-- Up Migration
-- B2-05m (规划/08 BR-WDR-26 超时判定「每单只判定一次」; 编排裁定 D10-467 ④, D10-475 ②(c)): the instant the
-- worker's review-overdue check (B2-05n) judged a withdrawal overdue. NULL = not judged; set once
-- while status ∈ {PENDING_REVIEW, APPROVED}; never written on a terminal row and never cleared.
-- Task B2-05m.
-- Compatibility: additive. app.withdrawals gains review_overdue_at timestamptz, nullable, no
-- default, no backfill (every existing row reads NULL = not judged, which is the truth: no check
-- has run). No constraint, index or trigger changes; existing inserts that omit the column keep
-- working.
-- Grants (0075's column ownership): UPDATE (review_overdue_at) goes to couli_app only — the worker
-- role that runs payout-overdue (the same process as payout-review); couli_payout and
-- couli_readonly keep their table-level SELECT, which covers the new column, and gain no write;
-- couli_maint has no grant on the table.
-- Recovery: no down migration. To roll back, a new migration revokes the column UPDATE from
-- couli_app and drops review_overdue_at (after the worker stops reading and writing it).
--
-- Timeouts: ADD COLUMN (nullable, no default) takes ACCESS EXCLUSIVE on app.withdrawals for a
-- catalog-only change, held to commit since the runner uses one transaction; 5s lock wait so a
-- blocked deploy fails fast instead of queueing withdrawal traffic behind it; 30s overall as a
-- ceiling for the catalog change and the grant.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE app.withdrawals ADD COLUMN review_overdue_at timestamptz;
-- app.withdrawals is a funds table (tools/ci/lint-migrations.ts): a plain nullable ADD COLUMN
-- without a default rewrites nothing and validates nothing, so no NOT VALID / VALIDATE split and
-- no squawk exception.
GRANT UPDATE (review_overdue_at) ON app.withdrawals TO couli_app;
