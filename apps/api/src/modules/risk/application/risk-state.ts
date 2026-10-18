// Risk state of a user (user_risk_state, 04 §3.2) and stage ⑤ of the request decision order
// (规划/08 BR-ID-01 判定顺序 ⑤: 10006; BR-ID-31 封禁与白名单; BR-ID-36 冻结期限与申诉; task B1-03h).
//
// Single writer: this service is the only code that writes app.user_risk_state. setRiskState
// inserts the user's row (row_version 0) or updates it with a compare-and-set on row_version
// (Kysely updateTable, `WHERE app_id AND user_id AND row_version`; 0 rows → RiskStateConflictError,
// the caller's transaction rolls back), and publishes risk.state_changed on the platform event bus
// in the same transaction (payload: app_id, user_id, from, to, reason_category, frozen_until — the
// frozen_until written with `to` = frozen as an ISO 8601 UTC string, null for any other `to`;
// never the raw reason or rule details). With expected_row_version (the console's compare-and-set,
// F1-07d) null only creates the user's first row while there is none and an integer only matches
// the current row_version; every other case is RiskStateConflictError before anything is written
// (a concurrent first insert losing on the primary key is one as well). Without it the write is
// as before. The side effects of a ban (sessions, union bindings; withdrawals are blocked by the
// state itself and never written) are orchestrated by the admin risk state command
// (admin-risk-state.ts, F1-07d), not here; frozen expiry is B1-03j's job, so a read never restores
// a state on its own.
//
// Reads: no row reads as normal. A process cache (≤60 s, keyed by app_id + user_id, aged with the
// injected Clock) serves the guard path; `fresh: true` reads the database. A change made through
// this service invalidates its key at once and marks it pending until a read sees the written
// row_version (i.e. the writer committed): until then reads go to the database and are not
// cached, so a concurrent read of the old value cannot leave a stale entry behind, and a rolled
// back write never leaks into the cache. Time is no evidence of a rollback (a slow reply of the
// old value may arrive long after the commit), so a pending mark has no timeout: a write that is
// never seen (rolled back, or its writer died) leaves its key reading the database, uncached,
// until a read sees that version or a later change of the key replaces the mark. A cache entry keeps the row_version it holds as the key's
// high-water mark (row_version only grows), so a late read of an older version never replaces a
// newer entry, and reads in flight when a write becomes visible lose the right to fill the cache.
// Before any write the change is checked against the transition table
// (../domain/risk-state-transitions.ts; not listed → RiskStateTransitionError, nothing written,
// nothing published). A read failure rejects unchanged (50001 through the global filter), never
// reads as normal.
//
// Other processes (F1-07d, BR-ID-01「封禁时必须主动失效」): with `redis` in the options, a Redis
// version stamp per (app_id, user_id) in namespace `risk-state` carries the highest row_version
// any process wrote or cached; every write of the stamp is a max (STAMP_SCRIPT: a larger stamp is
// never lowered) with a TTL of STAMP_TTL_SECONDS (more than twice the cache period).
// - setRiskState writes the stamp with the version it writes, before its caller commits; a failed
//   stamp rejects (the caller's transaction rolls back: 50001, never a change other processes
//   cannot see). The admin command writes it again after the commit (admin-risk-state.ts).
// - A cache fill first writes the version it caches as the stamp's baseline; when that fails, or
//   the stamp is then above the version read (a remote write not committed or not yet visible:
//   the remote pending mark), the value read decides this request and is not cached.
// - A cache hit first reads the stamp: missing (expired, Redis restarted or flushed), unreadable,
//   failed or above the entry's version → the database is read as on a miss. A hit is never
//   served without a stamp at most its version.
// - Without `redis` (unit and rule tests that build the service from { db, clock, events }) the
//   process cache works as above, alone; the risk.state_changed event has no cache consumer.
// Residual risks (accepted, ops/tasks/F1-07d.yaml): both need Redis to lose an acknowledged stamp
// while a process rebuilds or keeps the old baseline — requests between the commit and the stamp
// written after it may pass on the old value, and when every stamp after the commit fails remote
// entries live out the cache period (≤ 60 s). Reads of the sensitive operations always go to the
// database.
//
// Stage ⑤ (checkRequest): only a request with a verified principal (stage ②) is judged; the
// anonymous / x-auth none operations (the four logins among them) are not. state banned, or
// appealing while the user's processing account appeal has prev_risk_state banned (a cached
// appealing without a processing account appeal is re-read from the database first; still
// appealing without one is judged as banned: fail closed), refuses every
// operation outside the BR-ID-31 whitelist with 10006 (HTTP 403, no data). frozen is not judged
// here (30303 belongs to withdrawal acceptance). The sensitive operations of BR-ID-01 (the four
// x-step-up operations, x-auth realname, /v1/me/deletion*) read the database on every request.
// With a transaction (the idempotency post-miss hook) every read goes through it: the hook holds
// a pooled connection and must not borrow a second one; the cache is not used there.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import { HttpException } from '@nestjs/common';
import type { RiskState } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import {
  contractAuthOf,
  tokenPrincipal,
  type Clock,
  type EventBus,
  type TokenPrincipal,
  type RedisHandle,
} from '../../platform/index.ts';
import { canTransitionRiskState } from '../domain/risk-state-transitions.ts';

export type RiskReasonCategory =
  'malicious_rights' | 'fraud_invite' | 'abnormal_trade' | 'account_security' | 'other';

export interface RiskSubject {
  readonly app_id: string;
  readonly user_id: string;
}

/** Public read projection: no rule details or raw reason. Dates remain dates inside the API. */
export interface RiskStateSnapshot {
  readonly state: RiskState;
  readonly reason_category: RiskReasonCategory | null;
  readonly frozen_until: Date | null;
}

export interface SetRiskState extends RiskSubject, RiskStateSnapshot {
  readonly expected_row_version?: number | null;
  readonly reason: string | null;
  readonly changed_by: string;
}

/** Stage ⑤ input, after signature and token checks and stage ④a. */
export interface RiskStateRequest {
  readonly id: string;
  readonly method: string;
  readonly routeOptions: { readonly url?: string };
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly principal?: TokenPrincipal;
  readonly body?: unknown;
}

export interface RiskStateService {
  readRiskState(
    subject: RiskSubject,
    options?: { readonly fresh: boolean },
  ): Promise<RiskStateSnapshot>;
  /** Caller owns commit/rollback; CAS and event publication use exactly this transaction. */
  setRiskState(trx: Transaction<DB>, command: SetRiskState): Promise<void>;
  /** Post-miss callers pass their claim transaction; must not acquire a second connection. */
  checkRequest(request: RiskStateRequest, trx?: Transaction<DB>): Promise<void>;
}

export interface RiskStateOptions {
  /** The cross-process version stamp (above); absent: the process cache alone. */
  readonly redis?: RedisHandle;
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly events: EventBus;
}

/** Redis namespace of the risk state version stamps. */
export const RISK_STATE_STAMP_NAMESPACE = 'risk-state';
/** More than twice the cache period, so a stamp outlives any entry and a slow transaction. */
export const STAMP_TTL_SECONDS = 180;

/**
 * Writes ARGV[2] as the stamp unless the stamp holds a larger number; returns the stamp after.
 * An equal stamp is rewritten (its TTL renewed); a stamp that is not a number is replaced.
 */
const STAMP_SCRIPT = [
  "local current = redis.call('GET', KEYS[1])",
  'local wanted = tonumber(ARGV[2])',
  'local seen = nil',
  'if current then seen = tonumber(current) end',
  'if seen == nil or seen <= wanted then',
  "  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[1])",
  '  return ARGV[2]',
  'end',
  'return current',
].join('\n');

function stampKey(subject: RiskSubject): string {
  return `${subject.app_id}:${subject.user_id}`;
}

function stampValue(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !/^-?\d{1,15}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Raises the stamp of `subject` to `version` (never lowers it) and returns the stamp after the
 * write. Rejects when Redis fails or answers something that is not a version.
 */
export async function raiseRiskStateStamp(
  redis: RedisHandle,
  subject: RiskSubject,
  version: number,
): Promise<number> {
  const result = await redis.namespace(RISK_STATE_STAMP_NAMESPACE).eval(STAMP_SCRIPT, {
    keys: [stampKey(subject)],
    args: [String(version)],
    ttlSeconds: STAMP_TTL_SECONDS,
  });
  const stamp = stampValue(result);
  if (stamp === null) throw new Error('risk: the risk state stamp answer is not a version');
  return stamp;
}

/** The stamp of `subject`; null when it is missing. Rejects when Redis fails. */
async function readStamp(redis: RedisHandle, subject: RiskSubject): Promise<number | null> {
  const value = await redis.namespace(RISK_STATE_STAMP_NAMESPACE).get(stampKey(subject));
  if (value === null) return null;
  const stamp = stampValue(value);
  if (stamp === null) throw new Error('risk: the risk state stamp is not a version');
  return stamp;
}

const RISK_STATE_SERVICE = Symbol('RISK_STATE_SERVICE');

/** DI token of the same service instance used by the guard and post-miss hook. */
export function riskStateServiceToken(): symbol {
  return RISK_STATE_SERVICE;
}

/** BR-ID-01: the cache may serve a state for at most 60 seconds. */
const CACHE_TTL_MS = 60_000;
/** Upper bound of cached users per process; the oldest entry goes first beyond it. */
const CACHE_MAX_ENTRIES = 50_000;
/** The meaning of 10006 in contracts/error-codes.yaml. */
const BANNED_MSG = '账号已冻结或封禁';

/** The compare-and-set of setRiskState lost against a concurrent change (or the row vanished). */
export class RiskStateConflictError extends Error {
  constructor() {
    super('user_risk_state changed concurrently');
    this.name = 'RiskStateConflictError';
  }
}

/** The requested change is not in the transition table (../domain/risk-state-transitions.ts). */
export class RiskStateTransitionError extends Error {
  constructor(from: string | null, to: string) {
    super(`user_risk_state cannot change from ${from ?? '(no row)'} to ${to}`);
    this.name = 'RiskStateTransitionError';
  }
}

/** 10006: HTTP 403 with the contract envelope { code, msg, trace_id } and no data. */
export class RiskStateBannedException extends HttpException {
  constructor(traceId: string) {
    super({ code: 10006, msg: BANNED_MSG, trace_id: traceId }, 403);
    this.name = 'RiskStateBannedException';
  }
}

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)[name]
    : undefined;
}

type WhitelistEntry = true | ((body: unknown) => boolean);

/**
 * The 10006 whitelist of BR-ID-31, keyed by `METHOD route-template`; a function is the body
 * condition of a conditional entry (a body that does not meet it is refused).
 */
const WHITELIST: ReadonlyMap<string, WhitelistEntry> = new Map<string, WhitelistEntry>([
  ['GET /v1/me', true],
  ['GET /v1/withdrawals', true],
  ['GET /v1/withdrawals/:withdrawal_id', true],
  ['POST /v1/auth/logout', true],
  ['POST /v1/auth/refresh', true],
  [
    'POST /v1/auth/oauth-attempts',
    (body) => field(body, 'purpose') === 'step_up' && field(body, 'action') === 'account_deletion',
  ],
  ['POST /v1/auth/step-up', (body) => field(body, 'action') === 'account_deletion'],
  ['POST /v1/me/deletion', true],
  ['GET /v1/me/deletion', true],
  ['POST /v1/me/deletion/cancel', true],
  ['POST /v1/idempotency-keys/abandon', true],
  ['POST /v1/me/appeals', true],
  ['GET /v1/me/appeals', true],
]);

/** The four contract x-step-up operations (withdraw, phone change, payout account, deletion). */
const STEP_UP_OPERATIONS: ReadonlySet<string> = new Set([
  'POST /v1/withdrawals',
  'POST /v1/me/phone',
  'PUT /v1/me/payout-account',
  'POST /v1/me/deletion',
]);

function whitelisted(method: string, template: string | undefined, body: unknown): boolean {
  if (template === undefined) return false;
  const entry = WHITELIST.get(`${method} ${template}`);
  return entry === true || (entry !== undefined && entry(body));
}

/** BR-ID-01: withdrawal, payout account, real name, deletion and phone change read the database. */
function sensitive(method: string, template: string | undefined): boolean {
  if (template === undefined) return false;
  return (
    STEP_UP_OPERATIONS.has(`${method} ${template}`) ||
    template.startsWith('/v1/me/deletion') ||
    contractAuthOf(method, template) === 'realname'
  );
}

const NO_ROW: RiskStateSnapshot = Object.freeze({
  state: 'normal',
  reason_category: null,
  frozen_until: null,
});

interface Loaded {
  readonly snapshot: RiskStateSnapshot;
  /** row_version of the row read; null when there is no row. */
  readonly version: number | null;
}

interface CacheEntry {
  readonly snapshot: RiskStateSnapshot;
  /** row_version of the cached snapshot (-1: no row); the key's high-water mark. */
  readonly version: number;
  readonly at: number;
}

interface Pending {
  /** row_version the uncommitted (or rolled back) write produced. */
  readonly version: number;
}

/** PostgreSQL unique_violation (23505). */
function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

function keyOf(subject: RiskSubject): string {
  return JSON.stringify([subject.app_id, subject.user_id]);
}

async function load(db: Kysely<DB>, subject: RiskSubject): Promise<Loaded> {
  const row = await db
    .withSchema('app')
    .selectFrom('user_risk_state')
    .select(['state', 'reason_category', 'frozen_until', 'row_version'])
    .where('app_id', '=', subject.app_id)
    .where('user_id', '=', subject.user_id)
    .executeTakeFirst();
  if (row === undefined) return { snapshot: NO_ROW, version: null };
  return {
    snapshot: {
      state: row.state as RiskState,
      reason_category: row.reason_category as RiskReasonCategory | null,
      frozen_until: row.frozen_until,
    },
    version: Number(row.row_version),
  };
}

/** prev_risk_state of the user's processing account appeal; null when there is none. */
async function appealPrevious(db: Kysely<DB>, subject: RiskSubject): Promise<string | null> {
  const row = await db
    .withSchema('app')
    .selectFrom('appeals')
    .select(['prev_risk_state'])
    .where('app_id', '=', subject.app_id)
    .where('user_id', '=', subject.user_id)
    .where('target_type', '=', 'account')
    .where('status', '=', 'processing')
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.prev_risk_state ?? null;
}

export function createRiskStateService(options: RiskStateOptions): RiskStateService {
  const { db, clock, events, redis } = options;
  const cache = new Map<string, CacheEntry>();
  const pending = new Map<string, Pending>();
  /** Bumped on every change of any key: a read that straddles a change does not fill the cache. */
  let generation = 0;

  function nowMs(): number {
    return clock.now().getTime();
  }

  function within(at: number, now: number): boolean {
    const age = now - at;
    return age >= 0 && age <= CACHE_TTL_MS;
  }

  function remember(key: string, loaded: Loaded, now: number): void {
    const version = loaded.version ?? -1;
    // row_version only grows: a snapshot older than one already seen is a late read, dropped.
    const seen = cache.get(key);
    if (seen !== undefined && seen.version > version) return;
    cache.delete(key);
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done !== true) cache.delete(oldest.value);
    }
    cache.set(key, { snapshot: loaded.snapshot, version, at: now });
  }

  /** Whether a cache hit may be served: its stamp exists and is at most its version. */
  async function hitConfirmed(
    handle: RedisHandle,
    subject: RiskSubject,
    hit: CacheEntry,
  ): Promise<boolean> {
    try {
      const stamp = await readStamp(handle, subject);
      return stamp !== null && stamp <= hit.version;
    } catch {
      // A failed or unreadable stamp never confirms a hit: the database decides.
      return false;
    }
  }

  /** Writes the baseline of a fill; false (do not cache) on failure or above the version read. */
  async function baselineHeld(
    handle: RedisHandle,
    subject: RiskSubject,
    version: number,
  ): Promise<boolean> {
    try {
      return (await raiseRiskStateStamp(handle, subject, version)) <= version;
    } catch {
      return false;
    }
  }

  async function readRiskState(
    subject: RiskSubject,
    readOptions?: { readonly fresh: boolean },
  ): Promise<RiskStateSnapshot> {
    if (readOptions?.fresh === true) return (await load(db, subject)).snapshot;
    const key = keyOf(subject);
    const hit = cache.get(key);
    // Without Redis no await sits between the checks (the process cache alone, as before).
    if (
      hit !== undefined &&
      within(hit.at, nowMs()) &&
      (redis === undefined || (await hitConfirmed(redis, subject, hit)))
    ) {
      return hit.snapshot;
    }
    // An entry kept past its age (or not confirmed) stays the key's high-water mark; remember()
    // replaces it.
    const started = generation;
    const loaded = await load(db, subject);
    const after = nowMs();
    const write = pending.get(key);
    if (write !== undefined) {
      // Only the written row_version being visible clears the mark; elapsed time never does (a
      // slow reply of the value from before the commit is not a rollback): no cache fill here.
      const committed = loaded.version !== null && loaded.version >= write.version;
      if (!committed) return loaded.snapshot;
      pending.delete(key);
      // Reads still in flight may hold the value from before the write: they lose the right to
      // fill the cache (this read's own snapshot is at least the written version).
      generation += 1;
    } else if (started !== generation) {
      return loaded.snapshot;
    }
    const filling = generation;
    // The remote pending mark: a stamp above the version read forbids caching it.
    if (redis !== undefined && !(await baselineHeld(redis, subject, loaded.version ?? -1))) {
      return loaded.snapshot;
    }
    // A change of any key while the baseline was written: the value may predate it.
    if (filling === generation) remember(key, loaded, after);
    return loaded.snapshot;
  }

  async function setRiskState(trx: Transaction<DB>, command: SetRiskState): Promise<void> {
    const subject = { app_id: command.app_id, user_id: command.user_id };
    const app = trx.withSchema('app');
    const now = clock.now();
    const current = await app
      .selectFrom('user_risk_state')
      .select(['state', 'row_version'])
      .where('app_id', '=', subject.app_id)
      .where('user_id', '=', subject.user_id)
      .executeTakeFirst();
    const expected = command.expected_row_version;
    if (
      expected !== undefined &&
      (expected === null
        ? current !== undefined
        : current === undefined || Number(current.row_version) !== expected)
    ) {
      throw new RiskStateConflictError();
    }
    const from = current === undefined ? null : current.state;
    if (!canTransitionRiskState(from, command.state)) {
      throw new RiskStateTransitionError(from, command.state);
    }
    let written: number;
    if (current === undefined) {
      // A row of the same user_id under another app_id fails here (primary key), never updated.
      const inserting = app.insertInto('user_risk_state').values({
        app_id: subject.app_id,
        user_id: subject.user_id,
        state: command.state,
        reason: command.reason,
        reason_category: command.reason_category,
        frozen_until: command.frozen_until,
        changed_by: command.changed_by,
        changed_at: now,
        row_version: 0,
        created_at: now,
        updated_at: now,
      });
      try {
        await inserting.execute();
      } catch (error) {
        // A concurrent first row won the race: under the compare-and-set that is a conflict.
        if (expected !== undefined && uniqueViolation(error)) throw new RiskStateConflictError();
        throw error;
      }
      written = 0;
    } else {
      const version = Number(current.row_version);
      const result = await app
        .updateTable('user_risk_state')
        .set((eb) => ({
          state: command.state,
          reason: command.reason,
          reason_category: command.reason_category,
          frozen_until: command.frozen_until,
          changed_by: command.changed_by,
          changed_at: now,
          row_version: eb('row_version', '+', 1),
          updated_at: now,
        }))
        .where('app_id', '=', subject.app_id)
        .where('user_id', '=', subject.user_id)
        .where('row_version', '=', version)
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) throw new RiskStateConflictError();
      written = version + 1;
    }
    const key = keyOf(subject);
    generation += 1;
    cache.delete(key);
    pending.delete(key);
    if (pending.size >= CACHE_MAX_ENTRIES) {
      // Bounded like the cache. Dropping the oldest mark re-allows caching of its key, so reads
      // in flight lose the right to fill the cache (they may hold the value before that write).
      const oldest = pending.keys().next();
      if (oldest.done !== true) pending.delete(oldest.value);
    }
    pending.set(key, { version: written });
    // Other processes stop serving their entries of this user before the caller commits.
    if (redis !== undefined) await raiseRiskStateStamp(redis, subject, written);
    await events.publish(trx, {
      appId: subject.app_id,
      name: 'risk.state_changed',
      payload: {
        app_id: subject.app_id,
        user_id: subject.user_id,
        from: current === undefined ? 'normal' : current.state,
        to: command.state,
        reason_category: command.reason_category,
        // Only a freeze reports its expiry; every other state (appealing included, whose row may
        // keep the freeze's frozen_until) reports null.
        frozen_until:
          command.state === 'frozen' && command.frozen_until !== null
            ? command.frozen_until.toISOString()
            : null,
      },
    });
  }

  async function checkRequest(request: RiskStateRequest, trx?: Transaction<DB>): Promise<void> {
    const principal = tokenPrincipal(request);
    if (principal === undefined) return;
    const subject = { app_id: principal.app_id, user_id: principal.uid };
    const method = String(request.method).toUpperCase();
    const template = request.routeOptions.url;
    const fresh = trx !== undefined || sensitive(method, template);
    let snapshot =
      trx === undefined
        ? await readRiskState(subject, { fresh })
        : (await load(trx, subject)).snapshot;
    if (snapshot.state !== 'banned' && snapshot.state !== 'appealing') return;
    if (whitelisted(method, template, request.body)) return;
    if (snapshot.state === 'appealing') {
      let previous = await appealPrevious(trx ?? db, subject);
      if (previous === null && !fresh) {
        // A cached appealing without a processing account appeal may be stale (the appeal was
        // closed in another process): drop the entry and judge the database's state instead.
        generation += 1;
        cache.delete(keyOf(subject));
        snapshot = await readRiskState(subject, { fresh: true });
        if (snapshot.state !== 'banned' && snapshot.state !== 'appealing') return;
        if (snapshot.state === 'appealing') previous = await appealPrevious(db, subject);
      }
      // Still appealing without a processing account appeal: fail closed, judged as banned.
      if (snapshot.state === 'appealing' && previous !== null && previous !== 'banned') return;
    }
    throw new RiskStateBannedException(request.id);
  }

  return { readRiskState, setRiskState, checkRequest };
}
