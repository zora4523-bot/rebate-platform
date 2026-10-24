-- Up Migration
-- Order-side blocklist hits deduped per action, append only (orchestrator ruling D10-293; task
-- B1-09ab, after B1-09a / 0074).
-- Compatibility: rebuilds one partial unique index on app.risk_hits under the same name with
-- risk_action appended to the key; no column, constraint, data or grant changes. Every existing row
-- already satisfies the wider key (the old five-column key was stricter).
-- Recovery: restore from backup; no down migration (narrowing the key again is a new migration and
-- must first deal with orders that carry both actions).
--
-- risk_hits_blacklist_once_key becomes (app_id, rule_id, ref_type, ref_id, value_hmac, risk_action)
-- WHERE rule_id = 'BLACKLIST_HIT': one order and one blocklist value keep at most one manual_review
-- row and one void_commission row. A later ruling to void an order first recorded for manual review
-- inserts a second row instead of being dropped by the old key; the first row is never rewritten
-- (couli_app keeps SELECT / INSERT only on this evidence table, no UPDATE is granted). Retries of
-- the same action still end on this index. Partial on the same rule_id literal, so the other rules'
-- dedupe (e.g. risk_hits_same_device_once_key) is untouched.
--
-- Grants: none needed; no new column (couli_app keeps its column INSERT grants).
--
-- Timeouts: DROP INDEX takes an ACCESS EXCLUSIVE lock and CREATE INDEX a SHARE lock on
-- app.risk_hits (small table before launch), both inside the runner's single transaction, so no
-- writer sees the table without the index; 5s lock wait so a blocked deploy fails fast instead of
-- queueing risk writes behind it, 60s overall as a ceiling for the index build.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Same-name rebuild inside the runner's transaction (packages/db/scripts/migrate.ts): CONCURRENTLY
-- cannot run in a transaction, and the drop and the re-create must commit together so the key is
-- never missing. app.risk_hits is not a funds or attribution table.
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX app.risk_hits_blacklist_once_key;

CREATE UNIQUE INDEX risk_hits_blacklist_once_key
  ON app.risk_hits (app_id, rule_id, ref_type, ref_id, value_hmac, risk_action)
  WHERE rule_id = 'BLACKLIST_HIT';
