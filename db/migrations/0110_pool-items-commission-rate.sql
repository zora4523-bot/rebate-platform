-- Up Migration
-- Commission rate on pool items (08 BR-PRICE-11, BR-PROD-07: the cache and the pool keep the union's
-- public data, commission rate included; 规划/02 §14: a union failure reads the pool). The card quote
-- reads UnionItem.commission_rate_bp, and a pool row without it can neither compute the rebate nor
-- decide rebate_basis = no_rebate. Names and checks follow the orchestrator ruling in the B1-05u
-- brief §9. Task B1-05u; reading the column belongs to B1-05r.
-- Compatibility: additive. app.pool_items gains commission_rate_bp integer, the type of the column of
-- that name on app.orders; nullable, no default, no backfill: every existing row reads NULL until the
-- next refresh writes it, and inserts that omit the column keep working. app.orders has no check on
-- its column, so pool_items_commission_rate_bp_check is new here: at least 0 when set, no upper bound.
-- Other columns, indexes and the primary key are unchanged. Grants are unchanged: the table-level
-- privileges of couli_app and couli_readonly from 0107 cover the new column.
-- Recovery: no down migration. To roll back, a new migration drops
-- pool_items_commission_rate_bp_check, then drops the column commission_rate_bp (after the
-- application stops reading and writing it).
--
-- Timeouts: ADD COLUMN and ADD CONSTRAINT take ACCESS EXCLUSIVE on app.pool_items, held to commit
-- since the runner uses one transaction. 5s lock wait so a blocked deploy fails fast instead of
-- queueing pool reads behind it; 30s overall as a ceiling for the CHECK scan of a small table.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.pool_items ADD COLUMN commission_rate_bp integer;

-- app.pool_items is not a funds or attribution table. The runner applies migrations in one
-- transaction, so NOT VALID + VALIDATE would still scan under the ACCESS EXCLUSIVE lock taken by
-- ADD and gain nothing; the table is small (operator-curated items) and the new column is NULL on
-- every existing row, so a plain validated ADD is used, as in 0104 and 0106.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE app.pool_items ADD CONSTRAINT pool_items_commission_rate_bp_check
  CHECK (commission_rate_bp >= 0);
