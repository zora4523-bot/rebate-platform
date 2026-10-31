-- Up Migration
-- When the union's updated commission answered a rights deduction, on app.order_rights (08
-- BR-FUND-06 / BR-FUND-07 / BR-CALC-15; orchestrator ruling D10-483 for money review r1 S0 of task
-- B2-04lb). A SUCCEEDED rights row with a deduction lowers the commission credited before credit
-- only until the union reports the commission after it (a new estimate on the order sync, or a new
-- settlement record); the settlement module stamps answered_at on the same transaction, and the
-- deduction total before credit counts only rows whose answered_at is empty.
-- Compatibility: additive. One new nullable column without a default (the instant comes from the
-- injected Clock, never the SQL clock); existing rows read NULL in it and nothing is backfilled.
-- Existing columns, CHECKs, keys, indexes and table-level grants are unchanged.
-- Recovery: restore from backup; no down migration.
--
-- Shape after this migration:
--   order_rights:
--     answered_at  when the union's updated commission absorbed this row's deduction; NULL while
--                  the deduction is still open (or the row carries none).
--
-- Grants: couli_app keeps its table-level SELECT / INSERT / UPDATE (which already covers the new
-- column); the column grant below states settlement's write of answered_at explicitly.
-- couli_readonly keeps SELECT; couli_payout and couli_maint get nothing.
--
-- Timeouts: ADD COLUMN (nullable, no default) is a catalog-only change but takes ACCESS EXCLUSIVE
-- on the table briefly. 5s lock wait so a blocked deploy fails fast; 30s overall as a ceiling (no
-- scan or rewrite is expected).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.order_rights ADD COLUMN answered_at timestamptz;

GRANT UPDATE (answered_at) ON app.order_rights TO couli_app;
