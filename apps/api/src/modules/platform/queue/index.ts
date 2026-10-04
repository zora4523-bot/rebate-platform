// Job queue of the five process entries (ADR-0001 §2 队列与事件, §3 队列与事件一行与 02 §18 领域事件一行,
// §4.2 第 14 项 pg-boss schema, 第 19 项 任务去重键, 第 22 项 积压告警口径; 规划/02 §11 事件与异步, §18
// 一致性与并发, §5.3 payout 去重键, §7.1 窗口任务去重键, §3.1 payout concurrency=1). Every function below
// is implemented by task B1-01g. The rule tests in
// test/spec/platform/queue/** import this file by path; the names, signatures and semantics written
// here are the contract. Values that no document fixes are marked 待编排会话确认 (suggested defaults).
//
// 0. Layers
//    - Business code depends only on the `JobQueue` interface (`send`). pg-boss appears only in this
//      directory (and in packages/db); no type or value of pg-boss is exported from here, and no
//      file of apps/api/src outside this directory imports 'pg-boss' (ADR-0001 §2 "业务代码只依赖自有
//      JobQueue 接口"; 规划/02 §16.3 "不要绕过 JobQueue 直接调用队列库").
//    - `createQueueRuntime(options)` builds the runtime of one process entry: it is the JobQueue of
//      that process and, for worker and payout, the job executor.
//
// 1. Queues — `QUEUE_CATALOG`, `QueueSpec`
//    - Each catalog entry is one pg-boss queue of the same name in schema `pgboss`; a job's id is
//      its pg-boss job id (rows of pgboss.job / pgboss.queue are inspected with plain SQL, ADR-0001
//      §3 "排查用普通 SQL"). No `partition: true` queue (ADR-0001 §4.2 #14).
//    - Queue names: /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/, at most 50 characters (pg-boss caps a
//      name at 50 bytes). Names of 规划/02 §11: order-sync.<platform>, order-rescan, settle, payout,
//      notify, pool-refresh, poster, agent-trace, evt.<consumer>. `order-sync.<platform>` and
//      `evt.<consumer>` join the catalog with the tasks that bring their platforms and consumers.
//    - Policies: only 'standard' and 'exclusive' (section 4 says why).
//    - Production values (待编排会话确认 — ADR-0001 and 规划/02 give none except "失败窗口进死信队列"
//      (02 §7.1) and "任一队列 failed >0" alerting (02 §11)): every queue except `dead-letter` uses
//        retryLimit 5, retryDelaySeconds 10, retryBackoff true, retryDelayMaxSeconds 600,
//        expireInSeconds 900, retentionSeconds 1 209 600 (14 d), deleteAfterSeconds 604 800 (7 d),
//        deadLetter 'dead-letter';
//      policies: `payout` and `settle` 'exclusive' (their tasks carry dedup keys: 02 §5.3
//      `{withdrawal_id}:{execute_seq}`, 02 §11 settle.bill / settle.batch_execute), all others
//      'standard'. `dead-letter` (no worker; failed jobs of every queue are copied there and wait for
//      an operator): standard, retryLimit 0, retryDelaySeconds 1, retryBackoff false,
//      retryDelayMaxSeconds null, expireInSeconds 900, retentionSeconds 2 592 000 (30 d),
//      deleteAfterSeconds 2 592 000, deadLetter null. Catalog order: order-rescan, settle, payout,
//      notify, pool-refresh, poster, agent-trace, dead-letter.
//    - Catalog rules (`createQueueRuntime` throws QueueError('invalid_catalog') when the catalog it
//      is given breaks one): names valid and unique; policy one of the two; retryLimit integer
//      0..20; retryDelaySeconds integer 1..3600; retryBackoff boolean; retryDelayMaxSeconds null when
//      retryBackoff is false, else null or an integer from retryDelaySeconds to 86 400;
//      expireInSeconds integer 1..86 400; retentionSeconds and deleteAfterSeconds integers
//      60..2 592 000; deadLetter null or the name of ANOTHER catalog queue whose policy is 'standard'
//      and whose own deadLetter is null. Each entry must be a plain object with exactly the ten keys
//      of QueueSpec.
//
// 2. Who works which queue — `ENTRY_PLAN`, `WorkSpec`
//    - For each of the five entries, the queues its runtime may work, with a fixed concurrency (the
//      most handler calls of that queue running at once in that process, 1..10) and the polling
//      interval of that queue in seconds (0.5..60 in steps of 0.5; ADR-0001 §3: poster 0.5).
//    - Production values (待编排会话确认 except payout's 1, which is 规划/02 §3.1 "转账队列
//      concurrency=1"): api, stream, admin: none (they only send); worker: order-rescan 1 / 2 s,
//      settle 1 / 2 s, notify 5 / 2 s, pool-refresh 1 / 2 s, poster 2 / 0.5 s, agent-trace 2 / 2 s;
//      payout: payout 1 / 2 s. In this order.
//    - Plan rules (QueueError('invalid_catalog') otherwise): exactly the five entry keys; every item a
//      plain object with exactly queue, concurrency, pollingIntervalSeconds; queue in the catalog and
//      not the deadLetter of any catalog queue; a queue appears at most once in the whole plan (the
//      payout queue is worked by the payout entry only); concurrency integer 1..10;
//      pollingIntervalSeconds from 0.5 to 60 with 2 × value an integer.
//
// 3. Sending — `runtime.send(queue, name, payload, options)` (the `JobQueue` interface)
//    Checks, in this order, each failure rejecting with that QueueError and touching no database
//    connection (so a check failure inside a transaction leaves the transaction usable):
//      a. `queue` is a catalog queue                              else 'unknown_queue'
//      b. `name` matches /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/ and has at most 64 characters
//         (the job name inside the queue, 规划/02 §11 "细粒度任务作为 job name 落在上述队列下",
//         e.g. 'settle.bill', or an event name such as 'order.created' in an evt.* queue)
//                                                                     else 'invalid_name'
//      c. `payload` is a JSON object (below)                        else 'invalid_payload'
//      d. UTF-8 bytes of JSON.stringify(payload) ≤ MAX_PAYLOAD_BYTES (16 384; 待编排会话确认 — payloads
//         carry ids, not documents)                                  else 'payload_too_large'
//      e. `options` (below)                                         else 'invalid_option'
//      f. the runtime is running (start() resolved, stop() not yet called)
//                                                                     else 'not_running'
//    JSON object: a plain object (prototype Object.prototype or null) whose own properties are all
//    enumerable, string-keyed data properties (no symbol keys, no accessors) with JSON values. A JSON
//    value is null, a boolean, a safe integer (Number.isSafeInteger; no fractions, NaN, ±Infinity:
//    amounts are integer fen and rates integer bp, 02 §19), a string, an array (prototype
//    Array.prototype, no holes, no own properties besides its indices and length) of JSON values, or
//    a JSON object. Strings, keys included, must be well-formed UTF-16 (String#isWellFormed) and
//    contain no U+0000 (PostgreSQL jsonb rejects both). No cycles; at most 32 levels of nesting (the
//    payload itself is level 1). Anything else ('invalid_payload'): bigint, undefined, functions,
//    symbols, Date, Map, class instances, boxed primitives, typed arrays.
//    Options: a plain object with only these keys:
//      trx            REQUIRED key. A Kysely transaction of the entry's `db` handle, or null.
//                     Accepted exactly when it is null or an object whose `isTransaction` property
//                     is true (Kysely's own marker; no instanceof check, which a second copy of
//                     kysely would break). With a transaction the job is
//                     inserted on that transaction's connection: it exists exactly when the
//                     transaction commits (rollback → no job, the singletonKey and id are not held),
//                     and no worker sees it before the commit (ADR-0001 §2 "任务与业务写入同一事务入队",
//                     §4.2 #14 `send(..., { db: fromKysely(trx) })`; 规划/02 §11 "事务提交后才可被取走").
//                     null: the job is inserted on its own (autocommit) — for sends that go with no
//                     business write. A Kysely instance that is not a transaction (e.g. the `db`
//                     handle itself), a missing key, or anything else → 'invalid_option'.
//      id             optional. The job id: a lower-case canonical UUID
//                     /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ (for domain
//                     events: the event_id, 规划/02 §11 "任务 ID = event_id"). Absent: a new random id.
//      singletonKey   the dedup key (section 4): a string of 1..200 characters from [A-Za-z0-9:._+-].
//                     REQUIRED on an 'exclusive' queue, FORBIDDEN on a 'standard' queue (where pg-boss
//                     would silently ignore it) → 'invalid_option'.
//      delaySeconds   optional integer 0..2 592 000: the job becomes available that many seconds
//                     after its insert, measured by PostgreSQL time (pgboss.job_now()).
//    Any other key, or a value outside these rules → 'invalid_option'.
//    Result: resolves with the id of the inserted job (the given `id` when one was given), or null
//    when nothing was inserted because a job with that id already exists in that queue (any state,
//    until the maintenance deletes it) or because the singletonKey is held (section 4). A null is
//    silent: no error, no log line. Database errors (e.g. a transaction already committed or
//    aborted) reject unchanged.
//
// 4. singletonKey — measured on PostgreSQL 18.6 + pg-boss 12.34.0 (schema 42) as couli_app with
//    migrate:false on 2026-10-04 for this task (ADR-0001 §4.2 #19 "在 B1-01 实测"):
//      standard   a singletonKey alone dedups NOTHING: two sends with the same key both insert
//                 (only together with singletonSeconds, which this module does not offer).
//      short      a send is dropped (returns null) while a job of that key is `created` (queued,
//                 also when deferred); NOT while it is `active` or waiting in `retry`, so a job
//                 that failed and waits for its retry does not hold the key and two jobs of one key
//                 can end up running.
//      singleton  never drops a send (it limits active jobs per key instead).
//      stately    at most one job per key in each of created / retry / active.
//      exclusive  a send is dropped while a job of that key is created, retry or active; accepted
//                 again once it is completed, failed or cancelled. A job without key shares the
//                 empty key, so a keyless exclusive queue holds only one job at a time.
//      All:       the key is scoped to the queue; a rolled-back send does not hold it; a dropped
//                 send returns null silently (insert … ON CONFLICT DO NOTHING).
//    Conclusion: "同键任务还在队列里时新任务被静默丢弃" equals the policy 'exclusive' if "还在队列里"
//    means "not yet finished" (queued, waiting for a retry, or running), and 'short' only if it means
//    "queued and never started". This module offers 'exclusive' only (a retrying withdrawal step must
//    keep its key) and makes the key required there, so a forgotten key cannot collapse a queue to one
//    job. The ADR write-back is for the orchestration session.
//
// 5. Executing — `runtime.register(queue, handler)`, `runtime.start()`
//    - register: checks, in this order: catalog queue ('unknown_queue'); in this entry's plan
//      ('not_in_entry' — so api / stream / admin can register nothing); handler is a function
//      ('invalid_option'); no handler yet for that queue ('duplicate_handler'); the runtime was
//      never started ('already_started'). Throws synchronously; returns undefined.
//    - start(): rejects 'already_started' when called before (also after a failed start or a stop).
//      Then, in this order:
//        1. Schema check: reads pgboss.version. Unless it holds exactly one row equal to
//           PGBOSS_SCHEMA_VERSION (42), rejects QueueError('schema_mismatch') before anything else
//           (no queue created or changed, no worker, nothing logged). pg-boss always runs with
//           migrate:false (ADR-0001 §4.2 #14 "库版本与 schema 版本不一致时拒绝启动"); it never creates
//           or alters the schema.
//        2. Queues: first every catalog queue that already exists in pgboss.queue is compared
//           with the catalog; when one's policy or dead letter queue differs, rejects
//           QueueError('queue_mismatch') with nothing created or changed and no worker started.
//           Then every missing catalog queue is created with the catalog settings, and for the
//           existing ones the retry, expiry, retention and deletion settings are set to the
//           catalog values. Queues of the database that are not in the catalog are left alone.
//        3. Workers (worker and payout only): each registered queue is worked with its plan's
//           concurrency and polling interval; the worker entry also runs pg-boss supervision
//           (expiry of active jobs past expireInSeconds, deletion); payout and the HTTP entries do
//           not (待编排会话确认). No cron schedules yet (schedule:false). No LISTEN/NOTIFY.
//      A failed start leaves nothing running; stop() then resolves at once. Database errors (e.g.
//      the database cannot be reached) reject unchanged.
//    - Connections: every statement runs on a connection of the given `db` handle's pool (the
//      entry's pool of ADR-0001 §4.2 #11); this module opens no pool of its own.
//    - Handler: `(job: ReceivedJob) => Promise<void>`, called with a frozen plain object whose own
//      properties are exactly { id, queue, name, payload, attempt }: payload deep-equals what was
//      sent; attempt is 1 on the first call and grows by one per retry.
//      Resolves → the job is completed.
//      Throws or rejects → the job fails: it is retried after the queue's retry delay while it has
//      retries left (attempt ≤ retryLimit), else its state becomes 'failed' and pg-boss copies it into
//      the queue's dead letter queue (02 §7.1 "失败窗口进死信队列"). The stored output of the failed
//      job (and of its dead-letter copy) is exactly the JSON {"error": "handler_failed"}: nothing of
//      the thrown error (message, stack, properties) is stored or logged.
//      Delivery is at least once: a handler can run again for the same job (a retry after a failure
//      or an expiry, a crash between its effects and the completion). Handlers dedup themselves —
//      for domain events with `processed_events(consumer, event_id)` in the same transaction as the
//      effect (规划/02 §11, §18; ADR-0001 §3), event_id being job.id.
//
// 6. Stop — `runtime.stop()`
//    - From the first call no handler call starts and send() rejects 'not_running'.
//    - Handler calls already running are awaited, up to `stopTimeoutMs` (default 5 000, integer
//      1..60 000; 待编排会话确认, docker stop gives 10 s): their jobs are completed (or failed) as
//      usual and the `db` handle stays usable meanwhile. Order of a process shutdown: stop fetching →
//      wait for running handlers → (the entry then) close the pools.
//    - When handler calls are still running stopTimeoutMs after the call: one line, level warn,
//      message `queue_stop_timeout`, fields exactly { running } (the number still running, ≥ 1);
//      their jobs are failed (retried later per the queue settings) and stop() resolves without
//      waiting for them.
//    - Never closes the `db` handle. Resolves with undefined; never rejects. A second or concurrent
//      call resolves together with the first (at once when already stopped); also before start().
//
// 7. Log lines — only through `options.logger` itself (no child logger, no extra bindings), and only:
//      `job_failed`        level warn,  fields exactly { queue, jobName, jobId, attempt } — a handler
//                          failed and the job has retries left;
//      `job_failed_final`  level error, same fields — a handler failed on the last attempt;
//      `queue_error`       level error, fields exactly { code } — pg-boss reported a background
//                          error; code is the error's `code` when it is a string, else null;
//      `queue_stop_timeout` (section 6).
//    Never the payload, the error object or its message / stack, or connection parameters.
//
// 8. Errors — `QueueError`: name 'QueueError', `code`, the fixed message of QUEUE_ERROR_MESSAGES;
//    own properties exactly stack, message, name and code; no `cause`. Thrown synchronously by
//    createQueueRuntime and register, rejected by send and start.
//
// 9. createQueueRuntime(options) — throws synchronously:
//    - options: plain object with keys entry (one of the five), db (the entry's `db` handle), logger
//      (a RootLogger), and optional catalog (default QUEUE_CATALOG), plan (default ENTRY_PLAN),
//      stopTimeoutMs; a bad catalog or plan → 'invalid_catalog' (checked first); anything else
//      wrong (unknown key, bad entry, stopTimeoutMs out of range) → 'invalid_option'.
//    - Opens no connection: the first database statement is the one of start() or send().
//
// 10. Wiring (implementation of this task; outside what the rule tests can import, covered by the
//     implementer's unit tests and smoke-entries):
//     - PlatformModule provides the runtime of the entry as token `JOB_QUEUE` (typed `JobQueue`) when
//       dbHandles are present; platform/index.ts exports JOB_QUEUE and the types JobQueue,
//       JobPayload, SendOptions, ReceivedJob, JobHandler (no pg-boss type).
//     - entry.ts runEntry: after createDbHandles, `createQueueRuntime({ entry, db: handles.db, logger })`;
//       start() before the entry reports `started` (every entry: the schema check refuses a
//       mismatched database); a failed start → `startup_failed`, exit code 1, handles closed. With
//       COULI_EXIT_AFTER_INIT=1 the runtime is created but not started (smoke-entries runs without a
//       database). Shutdown on SIGTERM / SIGINT: HTTP entries close the HTTP server, then
//       runtime.stop(), then the handles; worker and payout runtime.stop(), then the context and
//       handles. The keep-alive timer of the worker entries stays until a job runner keeps the
//       process alive.
//     - No business handler exists yet: the modules that own the queues register theirs later.
//
// 11. Rules for the implementation
//     - This directory is compiled by the `test` project too (erasableSyntaxOnly, no decorators):
//       erasable syntax only (no parameter properties, enum, namespace, decorators), no NestJS,
//       `import type` for type-only imports, relative imports with `.ts`. Runtime imports only:
//       `node:*`, `kysely`, `pg-boss` and files of this directory; `@couli/db`, `../entries.ts` and
//       `../logging/logger.ts` type-only.
//     - No `process.env`; no wall clock (no Date.now(), new Date(), performance.now()): this module
//       reads no time at all — delays and retries are measured by PostgreSQL (pgboss.job_now()), so
//       CLOCK_NOW does not shift them (待编排会话确认: AC-S2-32's compressed clock on staging);
//       logs only through `options.logger`.
export * from './types.ts';
export { QUEUE_CATALOG, ENTRY_PLAN } from './catalog.ts';
export { createQueueRuntime } from './runtime.ts';
