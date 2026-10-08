// Risk state of a user (user_risk_state, 04 §3.2) and stage ⑤ of the request decision order
// (规划/08 BR-ID-01 判定顺序 ⑤: 10006; BR-ID-31 封禁与白名单; BR-ID-36 冻结期限与申诉; task B1-03h).
//
// Single writer: this service is the only code that writes app.user_risk_state. setRiskState
// inserts the user's row (row_version 0) or updates it with a compare-and-set on row_version
// (Kysely updateTable, `WHERE app_id AND user_id AND row_version`; 0 rows → RiskStateConflictError,
// the caller's transaction rolls back), and publishes risk.state_changed on the platform event bus
// in the same transaction (payload: app_id, user_id, from, to, reason_category; never the raw
// reason or rule details). The side effects of a ban (sessions, union bindings, withdrawals) are
// orchestrated by the admin ban command (F1-10 / B1-27), not here; frozen expiry is B1-03j's job,
// so a read never restores a state on its own.
//
// Reads: no row reads as normal. A process cache (≤60 s, keyed by app_id + user_id, aged with the
// injected Clock) serves the guard path; `fresh: true` reads the database. A change made through
// this service invalidates its key at once and marks it pending until a read sees the written
// row_version (i.e. the writer committed): until then reads go to the database and are not
// cached, so a concurrent read of the old value cannot leave a stale entry behind, and a rolled
// back write never leaks into the cache. Other instances learn of a change through the
// risk.state_changed event (a cache consumer is not wired yet: their entries age out within 60 s).
// A read failure rejects unchanged (50001 through the global filter), never reads as normal.
//
// Stage ⑤ (checkRequest): only a request with a verified principal (stage ②) is judged; the
// anonymous / x-auth none operations (the four logins among them) are not. state banned, or
// appealing while the user's processing account appeal has prev_risk_state banned (an appealing
// user without a processing account appeal is judged as banned: fail closed), refuses every
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
} from '../../platform/index.ts';

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
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly events: EventBus;
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
  readonly at: number;
}

interface Pending {
  /** row_version the uncommitted (or rolled back) write produced. */
  readonly version: number;
  readonly at: number;
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
  const { db, clock, events } = options;
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

  function remember(key: string, snapshot: RiskStateSnapshot, now: number): void {
    cache.delete(key);
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done !== true) cache.delete(oldest.value);
    }
    cache.set(key, { snapshot, at: now });
  }

  async function readRiskState(
    subject: RiskSubject,
    readOptions?: { readonly fresh: boolean },
  ): Promise<RiskStateSnapshot> {
    if (readOptions?.fresh === true) return (await load(db, subject)).snapshot;
    const key = keyOf(subject);
    const hit = cache.get(key);
    if (hit !== undefined) {
      if (within(hit.at, nowMs())) return hit.snapshot;
      cache.delete(key);
    }
    const started = generation;
    const loaded = await load(db, subject);
    const after = nowMs();
    const write = pending.get(key);
    if (write !== undefined) {
      const committed = loaded.version !== null && loaded.version >= write.version;
      // A write still invisible after the TTL was rolled back (or is a very long transaction).
      if (!committed && within(write.at, after)) return loaded.snapshot;
      pending.delete(key);
    }
    if (started === generation) remember(key, loaded.snapshot, after);
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
    let written: number;
    if (current === undefined) {
      // A row of the same user_id under another app_id fails here (primary key), never updated.
      await app
        .insertInto('user_risk_state')
        .values({
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
        })
        .execute();
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
    pending.set(key, { version: written, at: nowMs() });
    await events.publish(trx, {
      appId: subject.app_id,
      name: 'risk.state_changed',
      payload: {
        app_id: subject.app_id,
        user_id: subject.user_id,
        from: current === undefined ? 'normal' : current.state,
        to: command.state,
        reason_category: command.reason_category,
      },
    });
  }

  async function checkRequest(request: RiskStateRequest, trx?: Transaction<DB>): Promise<void> {
    const principal = tokenPrincipal(request);
    if (principal === undefined) return;
    const subject = { app_id: principal.app_id, user_id: principal.uid };
    const method = String(request.method).toUpperCase();
    const template = request.routeOptions.url;
    const snapshot =
      trx === undefined
        ? await readRiskState(subject, { fresh: sensitive(method, template) })
        : (await load(trx, subject)).snapshot;
    if (snapshot.state !== 'banned' && snapshot.state !== 'appealing') return;
    if (whitelisted(method, template, request.body)) return;
    if (snapshot.state === 'appealing') {
      const previous = await appealPrevious(trx ?? db, subject);
      if (previous !== null && previous !== 'banned') return;
    }
    throw new RiskStateBannedException(request.id);
  }

  return { readRiskState, setRiskState, checkRequest };
}
