-- Up Migration
-- Per-queue dead letter queues (task B1-01zzg; orchestrator ruling D10-183 ② R-01; 规划/02 §7.1
-- 失败窗口进死信队列、死信不自动重放). Every business queue <q> of the job queue catalog
-- (apps/api/src/modules/platform/queue/catalog.ts) now dead-letters into its own <q>.dead instead
-- of the global `dead-letter`. The runtime refuses to start (queue_mismatch) while an existing
-- queue's dead_letter differs from the catalog, so this migration brings existing queues in line
-- before the new catalog starts:
--   1. create every <q>.dead in pgboss.queue (settings of the former `dead-letter` queue:
--      standard, no retry, 30-day retention and deletion, no dead letter of its own);
--   2. only then point each existing business queue at its <q>.dead (pgboss.queue.dead_letter
--      references pgboss.queue(name) and the foreign key is not deferrable, so the order matters);
--   3. point the business jobs still waiting or running at the same <q>.dead (pg-boss copies a
--      job's own dead_letter column on its final failure), so no new job reaches `dead-letter`.
-- Business queues missing from the database are left to the runtime, which creates them with the
-- catalog's dead letter at startup. The `dead-letter` queue and the jobs already in it stay as they
-- are (the worker's dead letter scan still counts them); nothing is deleted.
-- Compatibility: additive for the schema (rows only, no DDL). An entry still running the previous
-- catalog would see queue_mismatch on its next start: deploy the new image together with this
-- migration. Idempotent: create_queue skips existing queues, the queue update only touches rows that
-- still point elsewhere, the job update only jobs that still point at 'dead-letter'.
-- Recovery: restore from backup; no down migration. (By hand: point the business queues and their
-- waiting jobs back at 'dead-letter'; the .dead queues may stay.)
--
-- Only rows of pgboss.queue (13 + 13) and the waiting / running jobs of 13 queues are touched: 5s
-- lock wait so a deploy blocked behind a long queue transaction fails fast, 30s overall.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

SELECT pgboss.create_queue(
  source.name || '.dead',
  '{"policy": "standard", "retryLimit": 0, "retryDelay": 1, "retryBackoff": false, "expireInSeconds": 900, "retentionSeconds": 2592000, "deleteAfterSeconds": 2592000, "partition": false}'::jsonb
)
FROM (
  VALUES
    ('order-sync'),
    ('order-rescan'),
    ('settle'),
    ('payout'),
    ('notify'),
    ('evt.notification-risk-state'),
    ('evt.notification-appeal-result'),
    ('pool-refresh'),
    ('page-schedule'),
    ('poster'),
    ('agent-trace'),
    ('risk-scan'),
    ('export')
) AS source (name);

UPDATE pgboss.queue
SET dead_letter = name || '.dead'
WHERE name IN (
    'order-sync',
    'order-rescan',
    'settle',
    'payout',
    'notify',
    'evt.notification-risk-state',
    'evt.notification-appeal-result',
    'pool-refresh',
    'page-schedule',
    'poster',
    'agent-trace',
    'risk-scan',
    'export'
  )
  AND dead_letter IS DISTINCT FROM name || '.dead';

UPDATE pgboss.job
SET dead_letter = name || '.dead'
WHERE name IN (
    'order-sync',
    'order-rescan',
    'settle',
    'payout',
    'notify',
    'evt.notification-risk-state',
    'evt.notification-appeal-result',
    'pool-refresh',
    'page-schedule',
    'poster',
    'agent-trace',
    'risk-scan',
    'export'
  )
  AND state IN ('created', 'retry', 'active')
  AND dead_letter = 'dead-letter';
