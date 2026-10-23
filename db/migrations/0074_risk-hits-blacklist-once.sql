-- Up Migration
-- Order-side blocklist hits written once (08 BR-ATTR-26; orchestrator plan orders-plan-b109-v2 §2,
-- J-16). Task B1-09a.
-- Compatibility: additive. One partial unique index on app.risk_hits; no column, constraint, data
-- or grant changes.
-- Recovery: restore from backup; no down migration (dropping the index is a new migration once no
-- writer relies on it).
--
-- risk_hits_blacklist_once_key: risk's order blocklist port records a BLACKLIST_HIT row once per
-- (app_id, rule_id, ref_type, ref_id, value_hmac) — one order (ref_type order, ref_id = order id)
-- and one blocklist value (value_hmac = HMAC of the value) — so a retried or concurrent pipeline
-- run on the same order adds no rows (hard rule 4: idempotency ends on a PG unique constraint).
-- dimension and risk_action are deliberately not in the key: a later run that decides another
-- action does not add a second row. Partial on rule_id, after the SAME_DEVICE_MULTI_ACCOUNT
-- precedent (0026), so the other rules' hits are unaffected.
--
-- Grants: none needed; risk_hits gets no new column (couli_app keeps its column INSERT grants).
--
-- Timeouts: CREATE INDEX takes a SHARE lock on app.risk_hits (small table before launch); 5s lock
-- wait so a blocked deploy fails fast instead of queueing risk writes behind it, 60s overall as a
-- ceiling for the index build.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE UNIQUE INDEX risk_hits_blacklist_once_key
  ON app.risk_hits (app_id, rule_id, ref_type, ref_id, value_hmac)
  WHERE rule_id = 'BLACKLIST_HIT';
