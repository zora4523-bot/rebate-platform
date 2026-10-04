// Idempotency-Key handling and the abandon primitive of the sensitive operations (规划/04 §5「幂等」,
// §3.2 idempotency_keys, §6.1 POST /v1/idempotency-keys/abandon, §7 20901 / 20903 / 40901; 08
// BR-WDR-07 幂等段, BR-ID-01 ④, BR-ID-08, BR-ID-10 细则「敏感操作的幂等键」, BR-ID-30 ⑤; 规划/02 §18
// 「幂等 API」: idempotency_keys plus the business unique constraints as the last line).
// Skeleton: every function throws `NotImplemented` until task B1-01i implements it. The rule tests
// in test/spec/platform/idempotency/** import this file by path; the names, signatures and
// semantics written here are the contract. Table shape: db/schema.sql (idempotency_keys after
// migration 0004: request_hash and response null exactly on abandoned rows; status processing /
// completed / abandoned; UNIQUE (app_id, subject, method, path, key)).
//
// 1. Who owns a key — `subjectOf(actor)` (规划/04 §5「幂等」)
//    actor = { userId, deviceId, phoneHmac }, each a string or null; the first non-null wins:
//      userId     → `u:<userId>`      logged-in request (the token's user)
//      deviceId   → `d:<deviceId>`    anonymous request with X-Device-Id
//      phoneHmac  → `p:<phoneHmac>`   landing page without a device (POST /v1/invites/landing-register;
//                                      the caller normalises the phone per BR-ID-05 and passes the
//                                      blind index of platform/crypto)
//    Formats (else IdempotencyError('invalid_subject')): userId and deviceId are lowercase
//    canonical UUID strings (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; both
//    are UUIDv7 issued by the server, 04 §5「字段」); phoneHmac is 64 lowercase hex characters. All
//    three null → IdempotencyError('invalid_subject'). Only the winning value is checked; the
//    later ones are ignored entirely (whatever they hold). The record's `user_id` column is
//    userId for a `u:` subject, else null.
//    Admin accounts have no idempotent operation in 04 §6.6 yet; no `a:` subject (待编排会话确认).
//
// 2. The key — header Idempotency-Key, contract schema IdempotencyKey: 8 to 64 characters of
//    [A-Za-z0-9_-] (contracts/openapi.yaml). Missing (undefined), empty or outside the format →
//    the response is 20001 (section 5), the handler does not run, the database is not touched.
//
// 3. The request hash — `requestHashOf(body)` = lowercase hex SHA-256 of the UTF-8 bytes of
//    `canonicalJson(body)` (BR-WDR-07: sha256(键名排序、无空白的规范化 JSON)).
//    `canonicalJson(body)`: `body` is the parsed JSON request body.
//      - undefined (no body at all) → '' (the empty string); this differs from null → 'null'.
//      - null, booleans, strings, finite numbers → JSON.stringify of the value (so -0 → '0',
//        1.0 → '1', strings keep JSON.stringify's escaping).
//      - arrays → '[' elements in their order, each canonical, joined by ',' ']'.
//      - plain objects (prototype Object.prototype or null) → '{' then for each own enumerable
//        string key, sorted by UTF-16 code units (the default Array.prototype.sort order, as RFC
//        8785), JSON.stringify(key) ':' canonical(value), joined by ',' '}'. Nothing is dropped:
//        a key whose value is null stays.
//      - no whitespace anywhere outside strings.
//      - anything else, at any depth (undefined inside an object or array, NaN, ±Infinity,
//        bigint, symbol, function, Date, Map, Buffer, any other class instance) →
//        IdempotencyError('invalid_request').
//    Only the body is hashed: method, path, app and subject are part of the unique key instead.
//
// 4. One request — `idempotency.execute(request, handler)` (standard operations) and
//    `idempotency.executeInTransaction(request, handler)` (the four sensitive operations).
//    request = { appId, actor, method, path, key, body, traceId }:
//      appId    the token's app_id, non-empty string
//      method   'POST' | 'PUT' | 'PATCH' | 'DELETE'
//      path     the concrete request path (path parameters filled in, so POST /v1/links/A/open and
//               POST /v1/links/B/open never share a record), starting with '/', without query
//               string or fragment (no '?' or '#')
//      key      the Idempotency-Key header value or undefined
//      body     the parsed JSON body (undefined when none)
//      traceId  the request's trace id; goes into every envelope this module builds
//    Bad appId / method / path / body → IdempotencyError('invalid_request') before anything else
//    (a programming error, not a client error); bad actor → 'invalid_subject'.
//    Scope of a record: (app_id, subject, method, path, key) — exactly the unique constraint.
//
//    Decision for an existing committed record of the scope (BR-ID-01 ④; BR-WDR-07 ⓪):
//      abandoned                      → 20903, without comparing the hash (BR-ID-10 细则)
//      completed, same request_hash   → replay: the stored status and body, byte for byte
//      completed, other request_hash  → 20901
//      processing (live)              → 40901, whatever the hash (待编排会话确认: 04 and BR-WDR-07
//                                       do not order 40901 against 20901 for a running request;
//                                       a running sensitive request is not visible at all, so the
//                                       standard mode answers 40901 as well)
//    In each of these cases the handler is not called. Replay comes before everything the
//    handler checks (ban, version gate, step-up: BR-ID-01 ④ before ④a–⑮, BR-ID-08), so a
//    completed record is returned without calling the handler even when it would now refuse.
//
//    What is stored (BR-WDR-07; 04 §5): the handler's result is stored when its envelope `code`
//    is 0 or 30000–39999. Any other code (1xxxx, 2xxxx, 4xxxx, 5xxxx) is not stored: the key has
//    no record afterwards and the same key may be sent again (step-up replay with the original
//    key, BR-ID-08; transport retries). A handler that throws (or rejects) stores nothing either;
//    the same error object is rethrown unchanged.
//    Stored form: `response` jsonb is exactly {"status": <HTTP status>, "body": <body string>}
//    where the body string is the exact text returned to the first caller (section 5); a replay
//    returns that string unchanged (no re-serialisation: jsonb would reorder object keys).
//
//    Standard mode — `execute(request, handler: () => Promise<HandlerResult>)`:
//      - Refuses the four sensitive (method, path) pairs of section 6 with
//        IdempotencyError('transactional_required') (they must use executeInTransaction).
//      - No record: inserts a `processing` row (request_hash set, response null) and commits it
//        on its own, then calls the handler outside any transaction of this module. Concurrent
//        requests of the same scope: exactly one inserts (the unique constraint decides; a
//        conflict is never surfaced as an error, the loser re-reads and decides as above), the
//        others get 40901 while the row is processing.
//      - After the handler: stored result → the row becomes `completed` with `response`; result
//        not stored, or the handler threw → the row is deleted. Both updates are conditional on
//        the row still being this request's processing row (same id, status processing, same
//        created_at). If it is not (taken over, see the lease), nothing is written, exactly one
//        line is logged — `options.logger.warn({ method, path }, 'idempotency_record_lost')` —
//        and the handler's response is still returned (source 'handler').
//      - Lease (待编排会话确认; no document gives a value): a processing row whose created_at is
//        at least `processingLeaseMs` (default 60 000) before clock.now() is stale (its process
//        died or hangs): the next request of the scope takes it over atomically (conditional
//        update: request_hash of the new request, created_at and expire_at from now) and runs
//        its handler, whatever the old hash was. created_at more recent than that → 40901. The
//        business unique constraints are the last line against a double effect (规划/02 §18).
//
//    Transactional mode — `executeInTransaction(request, handler: (trx) => Promise<HandlerResult>)`
//    for the four step-up operations (BR-ID-10 细则「敏感操作的幂等键」「作废与业务结果互斥」;
//    BR-WDR-07 ⑧; 04 §3.2):
//      - One database transaction holds the key, calls the handler with it (`trx`, a Kysely
//        Transaction bound to schema app like the db handle) and writes the record. The business
//        writes the handler makes through `trx` and the record commit together or not at all.
//      - No processing row is ever committed for these operations: while the handler runs, no
//        other session can see any row of the scope (a process that dies leaves no trace; the
//        key goes back to "no record").
//      - A request of the same scope arriving while such a transaction is open gets 40901 without
//        waiting for that transaction to end (a short bounded wait is acceptable; the rule tests
//        allow 3 s while the first transaction stays open for longer). Suggested: a transaction-
//        scoped advisory lock taken with pg_try_advisory_xact_lock on a hash of the scope
//        (two-int4 form, so it never collides with the one-bigint locks of BR-WDR-07 ③), plus
//        INSERT … ON CONFLICT DO NOTHING on the unique constraint, which stays the arbiter.
//      - Existing committed record → decided as above (abandoned → 20903 and the handler never
//        runs, so a key abandoned while the vendor call of PUT /v1/me/payout-account ran makes
//        that request roll back as a whole with 20903, BR-ID-10 细则).
//      - Stored result → commit with the `completed` row. Result not stored → roll back
//        everything (the handler's writes too) and return the response. Handler threw → roll
//        back, rethrow the same error.
//      - The commit itself fails (outcome unknown, e.g. the connection dropped during COMMIT) →
//        reject with IdempotencyError('outcome_unknown'): the HTTP layer must then answer without
//        the envelope (close the connection), BR-ID-10 细则「服务端的配合」. A failure before
//        COMMIT rolls back and rejects with the driver's error.
//
//    HandlerResult = { status, envelope }: status an integer 200–599; envelope a plain object
//    with integer `code` ≥ 0, string `msg`, string `trace_id` and optional `data`. The body is
//    JSON.stringify(envelope) — the handler's key order is kept. Anything else →
//    IdempotencyError('invalid_result'), handled like a thrown handler (row deleted / rolled
//    back, nothing stored).
//    IdempotentResponse = plain object with exactly { status, body, source }:
//      source 'handler'      the handler ran in this call (body = JSON.stringify(envelope))
//             'replay'       a stored response, unchanged
//             'idempotency'  an envelope this module built (section 5) or the abandon result
//
// 5. Envelopes this module builds (contract ErrorEnvelope; contracts/error-codes.yaml http):
//    body = JSON.stringify of an object whose keys are in this order: code, msg, data (only when
//    listed), trace_id = request.traceId.
//      20001  HTTP 400  msg 'Idempotency-Key is missing or malformed'  data {"fields":["idempotency-key"]}
//      20901  HTTP 409  msg 'Idempotency-Key was used with a different request body'
//      20903  HTTP 409  msg 'Idempotency-Key was abandoned'
//      40901  HTTP 409  msg 'a request with this Idempotency-Key is in progress'
//    The field name is the header name lower-cased, as platform/validation names header fields.
//
// 6. Sensitive operations — `SENSITIVE_OPERATIONS` (04 §5 step-up row; BR-ID-08):
//      withdraw               POST /v1/withdrawals          retention unlimited
//      payout_account_change  PUT  /v1/me/payout-account    retention unlimited
//      phone_change           POST /v1/me/phone             retention 30 days
//      account_deletion       POST /v1/me/deletion          retention 30 days
//    POST /v1/me/phone also serves the first binding (no step-up); the path is shared, so every
//    POST /v1/me/phone uses executeInTransaction.
//
// 7. Retention — `expire_at` (BR-ID-30 ⑤; BR-WDR-07): every row this module writes gets
//    created_at = clock.now() and expire_at = created_at + 30 days (IDEMPOTENCY_RETENTION_MS =
//    2 592 000 000 ms), except the rows of POST /v1/withdrawals and PUT /v1/me/payout-account
//    (any status, abandoned included): expire_at = 'infinity' — "不按 30 天清理，保留期 ≥ 提现单
//    保留期", and the retention of withdrawals is still open (BR-ID-30 ⑫, no deletion task), so
//    these rows are kept (待编排会话确认). A completion keeps the row's created_at and expire_at;
//    a lease takeover sets both anew. The column default now() is never relied on.
//    `purgeExpired()` deletes every row (any status, any app) whose expire_at < clock.now() and
//    resolves with the number deleted; rows with expire_at = 'infinity' are never deleted. The
//    04:00 schedule that calls it belongs to the worker (BR-ID-30), not to this task.
//
// 8. Abandon primitive — `idempotency.abandon({ appId, userId, action, key, traceId })`
//    (04 §6.1; BR-ID-10 细则「作废接口」). The HTTP route is task B1-02; it passes the token's
//    app_id and user and the request body's action and idempotency_key.
//      - action not one of the four of section 6 and/or key outside the format of section 2 →
//        20001 (HTTP 400, msg 'invalid abandon request', data {"fields": [...]} listing 'action'
//        and/or 'idempotency_key' in that order); nothing is touched.
//      - userId must pass the userId format of section 1, else IdempotencyError('invalid_subject').
//      - Scope: (appId, `u:<userId>`, method and path of the action, key). Atomically, under the
//        unique constraint: no record → insert {status abandoned, request_hash null, response
//        null, user_id userId, created_at now, expire_at per section 7} and answer abandoned;
//        abandoned record → abandoned again (no second row); completed record → completed with
//        `original`, nothing written; processing record, or the key held by an open transaction
//        of executeInTransaction → 40901 without waiting for it (as in section 4).
//      - Answer: HTTP 200, source 'idempotency', body JSON.stringify of
//        {code: 0, msg: '', data: {outcome, original}, trace_id} where original is null for
//        abandoned, and for completed the stored envelope reduced to {code, msg, data} (in that
//        order; `data` only when the stored envelope has it; no trace_id), unchanged otherwise.
//      - Banned or deleting accounts are not this primitive's concern (10006 / 10007 whitelists
//        are the route's, BR-ID-31, BR-ID-27); it grants no right to run the original operation.
//
// 9. Factory — `createIdempotency({ db, clock, logger, processingLeaseMs? })`
//    db: Kysely<DB> bound to schema app (platform/db `db` handle, role couli_app); clock: Clock —
//    the only source of time (no Date.now(), no new Date() without argument, no SQL now() for
//    values written or compared); logger: anything with pino's warn(fields, msg).
//    processingLeaseMs: an integer from 1 000 to 600 000 (default 60 000), else
//    IdempotencyError('invalid_option'). Creating touches neither db nor clock.
//
// 10. Logging and errors. The module logs nothing but the line of section 4 (never a body, a
//     key value, a hash or a stored response). IdempotencyError: name 'IdempotencyError', `code`,
//     the fixed message of its code (IDEMPOTENCY_ERROR_MESSAGES); own properties exactly stack,
//     message, name and code; no cause. Database errors other than the handled unique conflict
//     (and the lock-not-available of the bounded wait) reject with the driver's error.
//
// 11. Wiring (implementation of this task; outside what the rule tests import): PlatformModule
//     provides token IDEMPOTENCY = createIdempotency({ db: DB handle, clock: CLOCK, logger:
//     ROOT_LOGGER }) when database handles exist, exported from platform/index.ts. No global HTTP
//     hook or interceptor: controllers / use cases of the operations marked I call execute or
//     executeInTransaction (the transactional handler needs `trx`), after signature and token
//     checks (BR-ID-01 ①–③) and before everything else. The abandon route is B1-02.
//
// 12. Rules for the implementation: this file is compiled by the `test` project too
//     (erasableSyntaxOnly, no decorators): erasable syntax only (no parameter properties, enum,
//     namespace, decorators), no NestJS, `import type` for type-only imports, relative imports
//     with `.ts`. Runtime imports only: `node:crypto`, `kysely`, and files of this directory;
//     `@couli/db` and `../clock/index.ts` type-only. No process.env.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../clock/index.ts';

/** The four step-up actions (04 §2.5 step_up_action). */
export type StepUpAction =
  'withdraw' | 'payout_account_change' | 'phone_change' | 'account_deletion';

export type IdempotentMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Section 6. */
export const SENSITIVE_OPERATIONS: Readonly<
  Record<
    StepUpAction,
    Readonly<{ method: IdempotentMethod; path: string; retention: 'unlimited' | 'default' }>
  >
> = Object.freeze({
  withdraw: Object.freeze({ method: 'POST', path: '/v1/withdrawals', retention: 'unlimited' }),
  payout_account_change: Object.freeze({
    method: 'PUT',
    path: '/v1/me/payout-account',
    retention: 'unlimited',
  }),
  phone_change: Object.freeze({ method: 'POST', path: '/v1/me/phone', retention: 'default' }),
  account_deletion: Object.freeze({
    method: 'POST',
    path: '/v1/me/deletion',
    retention: 'default',
  }),
} as const);

/** 30 days (BR-ID-30 ⑤). */
export const IDEMPOTENCY_RETENTION_MS = 2_592_000_000;

/** Section 4, lease (待编排会话确认). */
export const DEFAULT_PROCESSING_LEASE_MS = 60_000;

export interface IdempotencyActor {
  readonly userId: string | null;
  readonly deviceId: string | null;
  readonly phoneHmac: string | null;
}

export interface IdempotentRequest {
  readonly appId: string;
  readonly actor: IdempotencyActor;
  readonly method: IdempotentMethod;
  readonly path: string;
  readonly key: string | undefined;
  readonly body: unknown;
  readonly traceId: string;
}

export interface ResponseEnvelope {
  readonly code: number;
  readonly msg: string;
  readonly data?: unknown;
  readonly trace_id: string;
}

export interface HandlerResult {
  readonly status: number;
  readonly envelope: ResponseEnvelope;
}

export interface IdempotentResponse {
  readonly status: number;
  readonly body: string;
  readonly source: 'handler' | 'replay' | 'idempotency';
}

export interface AbandonRequest {
  readonly appId: string;
  readonly userId: string;
  /** Unvalidated input from the request body. */
  readonly action: string;
  /** Unvalidated input from the request body. */
  readonly key: string;
  readonly traceId: string;
}

/** Anything with pino's `warn(fields, msg)`. */
export interface IdempotencyLogger {
  warn(fields: Readonly<Record<string, unknown>>, msg: string): void;
}

export interface IdempotencyOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: IdempotencyLogger;
  readonly processingLeaseMs?: number;
}

export interface Idempotency {
  execute(
    request: IdempotentRequest,
    handler: () => Promise<HandlerResult>,
  ): Promise<IdempotentResponse>;
  executeInTransaction(
    request: IdempotentRequest,
    handler: (trx: Transaction<DB>) => Promise<HandlerResult>,
  ): Promise<IdempotentResponse>;
  abandon(request: AbandonRequest): Promise<IdempotentResponse>;
  purgeExpired(): Promise<number>;
}

export type IdempotencyErrorCode =
  | 'invalid_option'
  | 'invalid_subject'
  | 'invalid_request'
  | 'invalid_result'
  | 'transactional_required'
  | 'outcome_unknown';

export const IDEMPOTENCY_ERROR_MESSAGES: Readonly<Record<IdempotencyErrorCode, string>> =
  Object.freeze({
    invalid_option: 'processingLeaseMs must be an integer from 1000 to 600000',
    invalid_subject: 'the request has no valid idempotency subject',
    invalid_request: 'the idempotent request is invalid',
    invalid_result: 'the handler returned an invalid result',
    transactional_required: 'this operation must use executeInTransaction',
    outcome_unknown: 'the transaction outcome is unknown',
  });

/** Section 10. */
export class IdempotencyError extends Error {
  readonly code: IdempotencyErrorCode;
  constructor(code: IdempotencyErrorCode) {
    super(IDEMPOTENCY_ERROR_MESSAGES[code]);
    this.name = 'IdempotencyError';
    this.code = code;
  }
}

/** Section 1. */
export function subjectOf(actor: IdempotencyActor): string {
  void actor;
  throw new Error('NotImplemented: subjectOf');
}

/** Section 3. */
export function canonicalJson(body: unknown): string {
  void body;
  throw new Error('NotImplemented: canonicalJson');
}

/** Section 3. */
export function requestHashOf(body: unknown): string {
  void body;
  throw new Error('NotImplemented: requestHashOf');
}

/** Section 9. */
export function createIdempotency(options: IdempotencyOptions): Idempotency {
  void options;
  throw new Error('NotImplemented: createIdempotency');
}
