-- Up Migration
-- Platform software service fee reported by the union order payload (PDD duo_id_service_fee, mapped
-- by the union adapter to UnionOrder.service_fee_fen; other platforms report none), persisted on the
-- order so the B1-08t snapshot retry scan can rebuild the commission base for PDD orders
-- (N = commission − service fee, the B1-08k deduction, BR-CALC-03 / BR-CALC-02) instead of skipping
-- them. Task B1-08v; orchestrator rulings D10-81 ③, D10-84 ①, D10-92.
-- Compatibility: additive. app.orders (partitioned by attr_at) gains service_fee_fen bigint
-- (integer fen), nullable, no default, no constraint; ALTER TABLE on the partitioned parent (not
-- ONLY) adds it to orders_default and to every partition created later. No backfill: existing rows
-- read NULL until the next changed payload is written (the orders module writes the reported value
-- as is on first import and on content-changed updates). Existing inserts and updates that omit the
-- column keep working. Grants are unchanged: the table-level SELECT / INSERT / UPDATE of couli_app
-- and SELECT of couli_readonly cover the new column.
-- Recovery: no down migration. app.orders is a funds / attribution table, so the column is never
-- dropped by a migration; to stop using it, the application stops reading and writing it and the
-- column stays NULL-able and unused.
--
-- Timeouts: ADD COLUMN without a default is a catalog-only change (no table rewrite, no scan) but
-- takes ACCESS EXCLUSIVE on app.orders and its partitions, held to commit since the runner uses one
-- transaction. 5s lock wait so a blocked deploy fails fast instead of queueing order sync traffic
-- behind it; 30s overall as a ceiling for the catalog changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE app.orders ADD COLUMN service_fee_fen bigint;
