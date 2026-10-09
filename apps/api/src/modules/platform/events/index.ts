// Domain events of the modular monolith (规划/02 §11 事件与异步, §18 领域事件一行, §19 删除一行; ADR-0001 §3
// 队列与事件一行与「02 §18 领域事件一行由本 ADR 改为…」, §4.2 第 1 项 主键, 第 5 项 分区粒度, 第 10 项 时钟, 第 16 项
// 领域事件留痕, 第 22 项 积压告警口径; 规划/04 §3.2 processed_events、event_log 两行). Every function below is
// implemented by task B1-01h. The rule tests in test/spec/platform/events/** import this file by path;
// the names, signatures and semantics written here are the contract. Values that no document fixes
// are marked 待编排会话确认 (suggested defaults).
//
// 0. What this module is
//    - A domain event is a job: it is enqueued with the business write in ONE PostgreSQL transaction,
//      once per subscribed consumer, into that consumer's queue `evt.<consumer>`, with job id =
//      event_id (02 §11 "按消费者进入 evt.<consumer> 队列，任务 ID = event_id"). Delivery is the
//      JobQueue's at-least-once delivery (platform/queue contract sections 3 and 5); there is no relay
//      process and no outbox table (02 §11 "不设单独的投递进程，也不另建事件发件表").
//    - In the same transaction one row is appended to `app.event_log` (ADR-0001 §4.2 #16). It is an
//      audit trail only: no consumer reads it, delivery never depends on it.
//    - A consumer dedups with `app.processed_events(consumer, event_id)` written in the same
//      transaction as its effects (02 §11 消费幂等; 04 §3.2).
//    - Money never depends on events (02 §11 "资金不依赖事件"): balances, entries and settlement
//      states change only inside their own transactions; events drive push, risk, dashboards and
//      traces. No ledger code may wait for, or be triggered by, an event.
//    - Business code depends on `EventBus` and `registerEventConsumer` only; it never writes
//      event_log or processed_events itself and never sends to an `evt.*` queue directly.
//
// 1. Event names — `EVENT_NAMES`
//    The event list of 规划/02 §11, in that order: order.created, order.updated, order.credited,
//    order.invalidated, order.clawed_back, order.settle_adjusted, claim.resolved, binding.changed,
//    member.registered, member.bound_parent, member.level_changed, wallet.withdrawal_changed,
//    withdrawal.created, account.went_negative, settle.batch_done, risk.state_changed,
//    appeal.resolved, agent.run_finished. A frozen array. Publishing any other name is refused
//    ('unknown_event'): a new event is added here, with its 02 §11 line, by the task that needs it.
//    Every name is `<entity>.<past-tense verb>` in snake_case, i.e. matches
//    /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/ (also a valid job name of the queue contract 3b).
//
// 2. An event — what `publish` takes: a plain object with exactly these keys
//      appId     REQUIRED. The app_id (brand) of the business row the event is about (02 §19 业务表
//                app_id NOT NULL): 1..64 characters from [A-Za-z0-9._-] (待编排会话确认 — no document
//                fixes the app_id format)                              else 'invalid_app_id'
//      name      REQUIRED. One of EVENT_NAMES                          else 'unknown_event'
//      payload   REQUIRED. The event data (below)
//      version   optional, default 1. The version of this event's payload shape: an integer 1..999.
//                A consumer that cannot read a version fails the job (dead letter) instead of
//                guessing (待编排会话确认)                              else 'invalid_version'
//      eventId   optional. A caller-chosen event id (e.g. derived from a business key so that a
//                repeated business write publishes the same event): a lower-case canonical UUID
//                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ (any version).
//                Absent: a new UUIDv7 (section 3)                       else 'invalid_event_id'
//    Missing required key, any other key, or not a plain object (prototype Object.prototype or null)
//    → 'invalid_event'.
//    Payload — ids, enums, integer amounts and flags only; never documents and never personal data
//    (02 §12.3; 待编排会话确认 for the bounds):
//      - A JSON object as defined in the queue contract 3 (plain object; own enumerable string-keyed
//        data properties only; values null, boolean, safe integer, string, plain array without holes
//        or extra properties, or JSON object; strings well-formed UTF-16 without U+0000; no cycles),
//        and in addition: every key, at any depth, matches /^[a-z][a-z0-9_]{0,63}$/ (snake_case,
//        02 §19); every string value has at most 128 UTF-16 code units; at most 3 levels of nesting
//        (the payload itself is level 1; an array or object inside it is level 2, …).
//                                                                     else 'invalid_payload'
//      - No key, at any depth, whose form without '_' equals the form without non-alphanumerics of
//        a personal-data key: every name of SENSITIVE_KEYS of platform/logging/redaction.ts, plus
//        email, name, nickname, address, ip, open_id, union_id. A payload that would need one of
//        these carries the owning row's id instead.             else 'personal_data'
//      - UTF-8 bytes of JSON.stringify(payload) ≤ MAX_EVENT_PAYLOAD_BYTES (4 096).
//                                                                     else 'payload_too_large'
//    Check order of publish: transaction, event shape, appId, name, version, eventId, then the
//    payload checks in the order above. Every check of this section runs before anything else: a failing check
//    reads no clock, runs no statement and touches nothing of `trx` but its `isTransaction`
//    property, so the business transaction stays usable.
//
// 3. Event id — `newEventId(now)`
//    A UUIDv7 (RFC 9562 §5.7; ADR-0001 §4.2 #1 "实体表用 UUIDv7"): the 48-bit big-endian Unix time in
//    milliseconds of `now`, version nibble 7, variant bits 10, and 74 bits from node:crypto random
//    bytes drawn fresh for every call; lower-case canonical text. `now` must be a Date whose time is
//    an integer 0..2^48−1 ms, else it throws EventError('invalid_option'). Ids made in the same
//    millisecond are distinct but not ordered. (packages/domain has no UUIDv7 generator yet; when it
//    gets one this function delegates to it — 待编排会话确认.)
//
// 4. Publishing — `createEventBus(options).publish(trx, event)`
//    - `trx` is the business transaction: an object whose `isTransaction` is true (Kysely's marker,
//      as the queue contract 3e). Anything else — null, the `db` handle itself, a missing value —
//      → 'invalid_transaction' (events are never published outside a business transaction).
//    - After the checks of section 2: reads `clock.now()` exactly once (that Date is the event's
//      occurred_at; ADR-0001 §4.2 #10 — never Date.now(), new Date() or SQL now()); a clock value
//      that is not a valid Date of 0..2^48−1 ms → 'invalid_option' with no statement run. eventId =
//      the given one, else newEventId(that instant).
//    - Then, all on `trx`:
//        0. Publishes on one `trx` run one after another in this process, in call order (a second
//           publish on the same transaction — e.g. under Promise.all — starts when the first has
//           settled), so the same event_id published twice on one transaction ends with one
//           event_log row and one job per consumer: the second resolves { duplicate: true }.
//           The first publish on a transaction reads its isolation level
//           (current_setting('transaction_isolation')); anything but 'read committed' (REPEATABLE
//           READ, SERIALIZABLE) rejects EventError('invalid_transaction') with nothing written or
//           sent and the transaction still usable — under a snapshot the lookup of b would miss a
//           row committed by a concurrent publish. Business transactions that publish run at
//           READ COMMITTED (the PostgreSQL default).
//        a. Serialises publishes of the same event_id across transactions (suggested: a
//           transaction-level advisory lock on a key derived from the event_id), so that two
//           concurrent publishes of one event_id end with one event_log row and one job per consumer.
//        b. Looks the event_id up in app.event_log (any partition). Found: when that row has the same
//           app_id and name and its payload equals {"v": version, "data": payload} (jsonb equality),
//           resolves { eventId, duplicate: true } with nothing written and nothing sent; otherwise
//           rejects EventError('event_conflict') with nothing written or sent.
//        c. Inserts one app.event_log row (section 5).
//        d. For every subscription whose `events` contains the name, in subscription order:
//           queue.send(`evt.<consumer>`, name, envelope, { trx, id: eventId }) — so each consumer
//           gets exactly one job, its id the event_id; no other option. Envelope (the job payload),
//           exactly: { "app_id": appId, "v": version, "occurred_at": <occurred_at as
//           Date#toISOString(), millisecond precision, Z>, "data": payload }.
//        e. Resolves a frozen plain object, exactly { eventId, duplicate: false }.
//      A rejection of the queue (e.g. QueueError 'not_running') or of the database rejects publish
//      unchanged; the caller's transaction then rolls back and with it the event_log row and every
//      job of this publish. Event with no subscriber: the event_log row only.
//    - Visibility follows the transaction: before commit no other connection sees the event_log
//      row or the jobs; after a rollback neither exists (02 §11 "事务提交后才可被取走").
//    - Never logs.
//
// 5. event_log row (ADR-0001 §4.2 #16; 04 §3.2 — fields fixed here, the table is
//    db/migrations/0003; no migration in this task)
//      id           generated (bigint identity; never exposed)
//      app_id       the event's appId
//      event_id     the event id
//      name         the event name
//      payload      {"v": version, "data": payload} (待编排会话确认 — the version has no column)
//      occurred_at  the clock instant of section 4 (partition key, monthly partitions)
//      created_at   column default
//    One row per published event (a duplicate publish adds none). Append-only (trigger
//    event_log_append_only); this module never updates or deletes it. Retention ≥ 190 days is the
//    partition dropping of task B1-01j, not this module. Not read by any consumer.
//
// 6. Subscriptions — `EVENT_SUBSCRIPTIONS`, `EventSubscription`
//    - The routing table, the same in every entry (the api entry publishes, the worker entry
//      consumes): a frozen array of { consumer, events }. Production value: empty — no consumer
//      exists yet. Each consumer is added by the task that brings it (notify, risk, dashboards,
//      agent-trace), and that task also adds the queue `evt.<consumer>` (policy 'standard') to
//      QUEUE_CATALOG and the worker's ENTRY_PLAN of platform/queue/catalog.ts; because
//      test/spec/platform/queue/contract.test.ts pins those lists exactly, that task needs a
//      test-change task first (规划/11 §4.4; the orchestration session opens it).
//    - Rules (createEventBus and registerEventConsumer throw EventError('invalid_subscriptions')
//      when one breaks): an array; each item a plain object with exactly the keys consumer and
//      events; consumer matches /^[a-z][a-z0-9-]{0,45}$/ (so `evt.<consumer>` is a valid queue name
//      of at most 50 characters) and is unique; events a non-empty array of distinct names of
//      EVENT_NAMES. For createEventBus also: `evt.<consumer>` is a queue of `options.catalog` whose
//      policy is 'standard' (job ids, not singleton keys, carry the dedup; queue contract 3e).
//
// 7. createEventBus(options) — throws synchronously
//    - options: a plain object with keys queue (a JobQueue: an object with a function `send`; the
//      entry's queue runtime), clock (a Clock: an object with a function `now`), optional
//      subscriptions (default EVENT_SUBSCRIPTIONS) and optional catalog (default QUEUE_CATALOG of
//      platform/queue; used only for the check of section 6). Unknown key, missing queue or clock,
//      or a value of the wrong kind → 'invalid_option' (checked first); then the subscriptions
//      → 'invalid_subscriptions'.
//    - Runs nothing at creation (no statement, no send, no clock read).
//
// 8. Consuming — `registerEventConsumer(runtime, options)`
//    - runtime: the worker entry's QueueRuntime (only its `register` is used). options: a plain
//      object with keys consumer, db (the entry's `db` handle), logger (a RootLogger: an object with
//      a function `info`), handler (a function), optional subscriptions (default
//      EVENT_SUBSCRIPTIONS). Checks, in this order, throwing synchronously: options →
//      'invalid_option'; subscriptions → 'invalid_subscriptions'; consumer not one of the
//      subscriptions' consumers → 'unknown_consumer'. Then calls
//      runtime.register(`evt.<consumer>`, jobHandler) once; a QueueError it throws (e.g.
//      'not_in_entry', 'duplicate_handler') propagates unchanged. Returns undefined.
//      Who calls it: the module that owns the consumer, in the worker entry, before the runtime is
//      started (queue contract 5); wiring arrives with the first consumer (待编排会话确认).
//    - jobHandler(job), for each delivery of a job of `evt.<consumer>`:
//        1. Checks the job, else rejects EventError('invalid_event') with no statement, no handler
//           call and no log line (the queue then retries and finally dead-letters it): job.id a
//           lower-case canonical UUID; job.name one of the events this consumer subscribes to;
//           job.payload exactly the four keys of the envelope (section 4d) with app_id per section 2,
//           v an integer 1..999, occurred_at exactly a string that publish can produce: the
//           Date#toISOString() text of an instant of 0..2^48−1 ms (section 4), i.e.
//           /^(\d{4}|\+0\d{5})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/ with a four-digit year up to
//           9999 or `+` and six digits from year 10000 on (never a sign before a smaller year, never
//           `-`), a real calendar date and time (month 01–12, day within the month, hour ≤ 23,
//           minute and second ≤ 59), and the instant 0..2^48−1 ms (so years 1970..10889);
//           data a plain object.
//        2. In ONE transaction of `options.db`: inserts (consumer, job.id) into app.processed_events
//           unless that pair exists (ON CONFLICT DO NOTHING — a concurrent delivery of the same pair
//           waits on the primary key until the first transaction ends). Inserted: calls
//           handler(event, trx) and the transaction commits when it resolves; its effects written
//           with that `trx` commit together with the processed_events row. After the handler
//           resolves, one statement (`select 1`) runs on `trx`: when the handler caught a database
//           error and returned anyway, the transaction is aborted, that statement fails (25P02) and
//           the delivery is handled as in step 3 (rollback, jobHandler rejects with that error, the
//           queue retries) instead of a commit that silently rolls back. A handler that rolled
//           back to its own savepoint leaves a usable transaction, which commits normally. Not
//           inserted (already processed): the handler is not called.
//        3. Handler rejects (or throws): the transaction rolls back — the processed_events row and
//           every effect written with `trx` disappear — and jobHandler rejects with that same error
//           unchanged, so the queue retries it per the queue settings and logs per the queue contract
//           (job_failed, no payload, no error text). A later attempt that succeeds takes effect
//           exactly once.
//        4. Resolves undefined (the job completes). After a skipped duplicate it logs exactly one
//           line through `options.logger` itself: level info, message `event_duplicate`, fields
//           exactly { consumer, eventId, eventName, attempt }. Nothing else is ever logged.
//      So a repeated delivery (retry after a crash, expiry, a second copy) takes effect once per
//      (consumer, event_id); consumers are independent — one consumer failing or lagging never
//      blocks, retries or dedups another.
//    - event (the handler's first argument): a frozen plain object with exactly { eventId (job.id),
//      appId (app_id), name (job.name), version (v), occurredAt (occurred_at, the string), payload
//      (data, deep-equal to what was published), consumer, attempt (job.attempt) }.
//    - Effects outside the database (a push, an HTTP call) cannot join the transaction: they are
//      at-least-once and must be idempotent on event_id themselves.
//    - processed_events rows are never deleted by this module (no retention rule yet; 待编排会话确认:
//      suggested cleanup older than the queue retention, by a later maintenance task).
//
// 9. Errors — `EventError`: name 'EventError', `code`, the fixed message of EVENT_ERROR_MESSAGES;
//    own properties exactly stack, message, name and code; no `cause`. No message, log line or
//    error of this module ever contains a payload value, an app_id or an event name beyond the
//    fields listed in section 8.4.
//
// 10. Wiring (implementation of this task; covered by the implementer's unit tests):
//     - PlatformModule provides `createEventBus({ queue: <the entry's queue runtime>, clock })` as
//       token `EVENT_BUS` (typed `EventBus`) whenever it provides JOB_QUEUE; platform/index.ts
//       exports EVENT_BUS, EventError, EVENT_NAMES, registerEventConsumer and the types EventBus,
//       DomainEvent, PublishResult, ReceivedEvent, EventHandler, EventSubscription.
//     - No consumer is registered yet.
//
// 11. Rules for the implementation
//     - This directory is compiled by the `test` project too (erasableSyntaxOnly, no decorators):
//       erasable syntax only, no NestJS, `import type` for type-only imports, relative imports with
//       `.ts`. Runtime imports only: `node:*`, `kysely`, `../queue/catalog.ts`,
//       `../logging/redaction.ts` and files of this directory; `@couli/db`, `../queue/types.ts`,
//       `../clock/clock.ts` and `../logging/logger.ts` type-only.
//     - No `process.env`; time only from the given Clock (no Date.now(), new Date() without an
//       argument, performance.now(), SQL now() for occurred_at). Logs only through the given logger.
//     - Data access only through the given Kysely transaction / handle (schema `app`), sends only
//       through the given JobQueue.
export * from './types.ts';
export { newEventId, createEventBus, registerEventConsumer } from './events.ts';
