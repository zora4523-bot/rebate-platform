// The paid bank-card verification records (规划/08 BR-WDR-02 ⑦ and 细则「核验次数上限」: 预占、核验记录、
// 落结果、在途租约、结果未知的复核、复核的终点; task B1-13f §9.2 #1 ③, #5, #6, #9).
//
// This file is the only writer of app.payout_account_verify_attempts (orchestrator ruling E39: no
// generated state machine; the legal transitions are the table below and every UPDATE carries the
// original status and row_version as its condition, so two writers never overwrite each other):
//
//   (insert)  → reserved            a request's reservation, inside the users row lock (one per
//                                   paid vendor call; a new vendor_request_id each time)
//   reserved  → unknown             the lease ran out (takeover, request or background), or the
//                                   vendor call ended without a definite answer (timeout, error)
//   reserved  → matched | mismatched   the vendor's answer to this reservation's call
//   unknown   → matched | mismatched   a recheck by the original vendor_request_id
//   unknown   → expired_unresolved     the vendor knows no such request, or the recheck deadline
//                                      passed without an answer (one pino error line, the alarm)
//   matched, mismatched, expired_unresolved: final. released is never written (whether the day's
//   quota is refunded is still open with finance, 9.2 #5): no transition leads there.
//
// SET is always status, row_version + 1, updated_at, plus unknown_at (→ unknown) or resolved_at
// (→ any final status), the columns couli_app may update (migration 0009). Times come from the
// injected Clock only.
//
// createPayoutAccountVerifyAttempts — the background seam B1-13g's scheduled task calls:
// - takeover: a reserved row whose lease (withdraw.payout_account_verify_inflight_timeout_sec,
//   default 60, measured from reserved_at; now ≥ reserved_at + lease is expired) has passed becomes
//   unknown; anything else is left as it is.
// - recheck: an unknown row is queried once by its vendor_request_id (never a new verification,
//   which could be charged again): match → matched, mismatch → mismatched, not_found →
//   expired_unresolved; still no answer (or no vendor assembled) and now ≥ unknown_at +
//   withdraw.payout_account_verify_recheck_minutes (default 30) → expired_unresolved with one
//   error line carrying only user_id, verify_date and vendor_request_id
//   (TODO(规划/11 §2.3): 向运营告警 — blocked on 告警通道任务 E43). Other statuses are not queried.
// Neither writes payout_accounts, an idempotency result or a refund: binding stays the user's own
// request (细则「核验结果与保存分开」). The vendor call holds no transaction and no users lock.
//
// Configuration (E40): the four withdraw.payout_account_verify_* keys are positive whole numbers;
// a missing or malformed value takes the default with a pino warning carrying only config_key.
//
// Nothing here logs or returns a card number, ID number, name, HMAC or request fingerprint, and a
// vendor error is never logged or rethrown (its message may carry the submitted values).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { BankCardVerifierPort } from '../ports/bank-card-verifier.ts';
import { readConfig, type PayoutAccountConfigPort } from './payout-account.ts';

// B1-13f background seam for B1-13g: no account save or quota refund here.
// reserved -> unknown; unknown -> matched | mismatched | expired_unresolved.
// Every update must compare original status and row_version. released is not written.
export interface PayoutAccountVerifyAttemptsOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly verifier: BankCardVerifierPort | null;
  readonly config?: PayoutAccountConfigPort;
}

export interface PayoutVerifyAttemptSubject {
  readonly appId: string;
  readonly id: string;
}

export interface PayoutAccountVerifyAttempts {
  takeover(subject: PayoutVerifyAttemptSubject): Promise<void>;
  recheck(subject: PayoutVerifyAttemptSubject): Promise<void>;
}

export type VerifyAttemptStatus =
  'reserved' | 'matched' | 'mismatched' | 'unknown' | 'expired_unresolved' | 'released';

/** One record as this module reads it (verify_date as its YYYY-MM-DD text). */
export interface VerifyAttempt {
  readonly id: string;
  readonly app_id: string;
  readonly user_id: string;
  readonly verify_date: string;
  readonly status: VerifyAttemptStatus;
  readonly vendor_request_id: string;
  readonly reserved_at: Date;
  readonly unknown_at: Date | null;
  readonly resolved_at: Date | null;
  readonly idempotency_key: string | null;
  readonly row_version: number;
}

/** The legal transitions of the file header (released has no way in, final states no way out). */
const TRANSITIONS: Readonly<Record<VerifyAttemptStatus, readonly VerifyAttemptStatus[]>> =
  Object.freeze({
    reserved: ['unknown', 'matched', 'mismatched'],
    unknown: ['matched', 'mismatched', 'expired_unresolved'],
    matched: [],
    mismatched: [],
    expired_unresolved: [],
    released: [],
  });

const STATUSES: ReadonlySet<string> = new Set(Object.keys(TRANSITIONS));

export function isLegalTransition(from: VerifyAttemptStatus, to: VerifyAttemptStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export const VERIFY_PER_DAY_KEY = 'withdraw.payout_account_verify_per_day';
export const VERIFY_INFLIGHT_KEY = 'withdraw.payout_account_verify_inflight_timeout_sec';
export const VERIFY_RECHECK_KEY = 'withdraw.payout_account_verify_recheck_minutes';
export const VERIFY_REUSE_KEY = 'withdraw.payout_account_verify_reuse_hours';
export const VERIFY_CONFIG_KEYS: readonly string[] = Object.freeze([
  VERIFY_PER_DAY_KEY,
  VERIFY_INFLIGHT_KEY,
  VERIFY_RECHECK_KEY,
  VERIFY_REUSE_KEY,
]);
/** BR-WDR-02 ⑦ default 3; the other three are the agent-completed defaults of 细则. */
const DEFAULTS: Readonly<Record<string, number>> = Object.freeze({
  [VERIFY_PER_DAY_KEY]: 3,
  [VERIFY_INFLIGHT_KEY]: 60,
  [VERIFY_RECHECK_KEY]: 30,
  [VERIFY_REUSE_KEY]: 24,
});

export interface VerifySettings {
  /** Paid verifications per user per +08:00 natural day. */
  readonly perDay: number;
  readonly inflightSeconds: number;
  readonly recheckMinutes: number;
  readonly reuseHours: number;
}

/**
 * One verification setting out of values already read (readConfig of payout-account.ts): a
 * positive whole number, else the default with a warning that carries only config_key.
 */
export function verifySetting(
  config: ReadonlyMap<string, unknown>,
  key: string,
  logger: RootLogger,
): number {
  const value = config.get(key);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  logger.warn({ config_key: key }, 'payout_account_config_default');
  const fallback = DEFAULTS[key];
  if (fallback === undefined) throw new Error('identity: not a verification setting');
  return fallback;
}

/** The four verification settings (the request path needs all of them). */
export function verifySettings(
  config: ReadonlyMap<string, unknown>,
  logger: RootLogger,
): VerifySettings {
  return {
    perDay: verifySetting(config, VERIFY_PER_DAY_KEY, logger),
    inflightSeconds: verifySetting(config, VERIFY_INFLIGHT_KEY, logger),
    recheckMinutes: verifySetting(config, VERIFY_RECHECK_KEY, logger),
    reuseHours: verifySetting(config, VERIFY_REUSE_KEY, logger),
  };
}

/** 在途租约: a reserved row is in flight for inflightSeconds from reserved_at. */
export function leaseExpired(
  attempt: Pick<VerifyAttempt, 'reserved_at'>,
  now: Date,
  inflightSeconds: number,
): boolean {
  return now.getTime() >= attempt.reserved_at.getTime() + inflightSeconds * 1000;
}

/** 复核的终点: recheckMinutes after unknown_at (reserved_at for a row that lacks it). */
export function recheckDue(
  attempt: Pick<VerifyAttempt, 'reserved_at' | 'unknown_at'>,
  now: Date,
  recheckMinutes: number,
): boolean {
  const since = (attempt.unknown_at ?? attempt.reserved_at).getTime();
  return now.getTime() >= since + recheckMinutes * 60_000;
}

/** 复用有效期: a matched row is reusable for reuseHours from resolved_at. */
export function reusable(
  attempt: Pick<VerifyAttempt, 'status' | 'resolved_at'>,
  now: Date,
  reuseHours: number,
): boolean {
  return (
    attempt.status === 'matched' &&
    attempt.resolved_at !== null &&
    now.getTime() < attempt.resolved_at.getTime() + reuseHours * 3_600_000
  );
}

/** Single vendor call budget (9.2 #7: about 10 seconds; a hang or an error counts as unknown). */
export const VENDOR_CALL_TIMEOUT_MS = 10_000;

const TIMED_OUT = Symbol('vendor_timed_out');

export type VendorCallFailure = 'timeout' | 'error';

/**
 * Runs one vendor call with a timer-only deadline (no clock read). A late settlement after the
 * deadline is ignored (its rejection swallowed). Never rethrows: the error may carry the input.
 */
export async function callVendor<T>(
  call: () => Promise<T>,
  timeoutMs: number = VENDOR_CALL_TIMEOUT_MS,
): Promise<{ readonly value: T } | { readonly failure: VendorCallFailure }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const calling = Promise.resolve().then(call);
    calling.catch(() => undefined);
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    const outcome = await Promise.race([calling, timeout]);
    return outcome === TIMED_OUT ? { failure: 'timeout' } : { value: outcome };
  } catch {
    return { failure: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

export type QueryOutcome = 'match' | 'mismatch' | 'not_found' | 'unknown';

/** The recheck query of one record, mapped to the four outcomes (no answer → unknown). */
export async function queryAttempt(
  verifier: BankCardVerifierPort,
  attempt: Pick<VerifyAttempt, 'user_id' | 'vendor_request_id'>,
  logger: RootLogger,
  timeoutMs: number = VENDOR_CALL_TIMEOUT_MS,
): Promise<QueryOutcome> {
  const result = await callVendor(() => verifier.query(attempt.vendor_request_id), timeoutMs);
  if ('failure' in result) {
    logger.warn(
      {
        user_id: attempt.user_id,
        vendor_request_id: attempt.vendor_request_id,
        failure: result.failure,
      },
      'payout_account_verify_query_failed',
    );
    return 'unknown';
  }
  const value: unknown = result.value;
  if (value === 'match' || value === 'mismatch' || value === 'not_found' || value === 'unknown') {
    return value;
  }
  logger.warn(
    { user_id: attempt.user_id, vendor_request_id: attempt.vendor_request_id },
    'payout_account_verify_query_unexpected',
  );
  return 'unknown';
}

const COLUMNS = [
  'id',
  'app_id',
  'user_id',
  'status',
  'vendor_request_id',
  'reserved_at',
  'unknown_at',
  'resolved_at',
  'idempotency_key',
  'row_version',
] as const;

type Row = Omit<VerifyAttempt, 'status'> & { readonly status: string };

function attemptOf(row: Row): VerifyAttempt {
  // The column has a CHECK; anything else is a broken database.
  if (!STATUSES.has(row.status)) throw new Error('identity: unknown verification attempt status');
  return { ...row, status: row.status as VerifyAttemptStatus };
}

function attempts(handle: Kysely<DB>) {
  return handle
    .withSchema('app')
    .selectFrom('payout_account_verify_attempts')
    .select(COLUMNS)
    .select(sql<string>`verify_date::text`.as('verify_date'));
}

/** One record by (app_id, id), or undefined (another app's id is not found). */
export async function attemptById(
  handle: Kysely<DB>,
  subject: PayoutVerifyAttemptSubject,
): Promise<VerifyAttempt | undefined> {
  const row = await attempts(handle)
    .where('app_id', '=', subject.appId)
    .where('id', '=', subject.id)
    .executeTakeFirst();
  return row === undefined ? undefined : attemptOf(row);
}

export interface AttemptOwner {
  readonly appId: string;
  readonly userId: string;
}

/** The record bound to this Idempotency-Key of the user (at most one, partial unique index). */
export async function attemptByKey(
  handle: Kysely<DB>,
  owner: AttemptOwner,
  key: string,
): Promise<VerifyAttempt | undefined> {
  const row = await attempts(handle)
    .where('app_id', '=', owner.appId)
    .where('user_id', '=', owner.userId)
    .where('idempotency_key', '=', key)
    .executeTakeFirst();
  return row === undefined ? undefined : attemptOf(row);
}

/** The user's latest record of this request fingerprint (by reserved_at, then id). */
export async function latestAttempt(
  handle: Kysely<DB>,
  owner: AttemptOwner,
  fingerprint: string,
): Promise<VerifyAttempt | undefined> {
  const row = await attempts(handle)
    .where('app_id', '=', owner.appId)
    .where('user_id', '=', owner.userId)
    .where('request_fingerprint', '=', fingerprint)
    .orderBy('reserved_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row === undefined ? undefined : attemptOf(row);
}

/** 已占用: the user's records of this +08:00 day (YYYY-MM-DD) in any status but released. */
export async function occupiedToday(
  handle: Kysely<DB>,
  owner: AttemptOwner,
  verifyDate: string,
): Promise<number> {
  const row = await handle
    .withSchema('app')
    .selectFrom('payout_account_verify_attempts')
    .select((eb) => eb.fn.countAll<string | number | bigint>().as('n'))
    .where('app_id', '=', owner.appId)
    .where('user_id', '=', owner.userId)
    .where('verify_date', '=', sql<Date>`${verifyDate}::date`)
    .where('status', '<>', 'released')
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export interface NewReservation extends AttemptOwner {
  readonly id: string;
  readonly verifyDate: string;
  readonly vendorRequestId: string;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
  readonly now: Date;
}

/** Inserts the reserved record (the caller holds the users row lock). */
export async function insertReservation(
  handle: Kysely<DB>,
  reservation: NewReservation,
): Promise<VerifyAttempt> {
  await handle
    .withSchema('app')
    .insertInto('payout_account_verify_attempts')
    .values({
      id: reservation.id,
      app_id: reservation.appId,
      user_id: reservation.userId,
      verify_date: reservation.verifyDate,
      status: 'reserved',
      vendor_request_id: reservation.vendorRequestId,
      request_fingerprint: reservation.fingerprint,
      reserved_at: reservation.now,
      unknown_at: null,
      resolved_at: null,
      origin_action: 'payout_account_change',
      idempotency_key: reservation.idempotencyKey,
      row_version: 0,
      created_at: reservation.now,
      updated_at: reservation.now,
    })
    .execute();
  return {
    id: reservation.id,
    app_id: reservation.appId,
    user_id: reservation.userId,
    verify_date: reservation.verifyDate,
    status: 'reserved',
    vendor_request_id: reservation.vendorRequestId,
    reserved_at: reservation.now,
    unknown_at: null,
    resolved_at: null,
    idempotency_key: reservation.idempotencyKey,
    row_version: 0,
  };
}

/** The partial unique indexes a racing reservation would hit (both answer 40901). */
export const RESERVATION_CONFLICTS: ReadonlySet<string> = new Set([
  'payout_account_verify_attempts_inflight_key',
  'payout_account_verify_attempts_idempotency_key',
]);

/**
 * One CAS step: the row moves from attempt.status (at attempt.row_version) to `to`. The returned
 * record is the new state, or undefined when the row is no longer what the caller read.
 */
export async function transitionAttempt(
  handle: Kysely<DB>,
  attempt: VerifyAttempt,
  to: VerifyAttemptStatus,
  now: Date,
): Promise<VerifyAttempt | undefined> {
  if (!isLegalTransition(attempt.status, to)) {
    throw new Error(`identity: illegal verification transition ${attempt.status} → ${to}`);
  }
  const stamp = to === 'unknown' ? { unknown_at: now } : { resolved_at: now };
  const result = await handle
    .withSchema('app')
    .updateTable('payout_account_verify_attempts')
    .set({ status: to, row_version: attempt.row_version + 1, updated_at: now, ...stamp })
    .where('app_id', '=', attempt.app_id)
    .where('id', '=', attempt.id)
    .where('status', '=', attempt.status)
    .where('row_version', '=', attempt.row_version)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) return undefined;
  return { ...attempt, ...stamp, status: to, row_version: attempt.row_version + 1 };
}

/**
 * Records a vendor answer (matched / mismatched) for a record the caller read: a CAS from what it
 * read; when someone else moved the row first, the current row is reread and the answer applied
 * once more from there (a takeover to unknown in between). True when the row ends in `to`
 * (written here or already there), false when it reached another final state.
 */
export async function settleAttempt(
  handle: Kysely<DB>,
  attempt: VerifyAttempt,
  to: 'matched' | 'mismatched' | 'unknown' | 'expired_unresolved',
  now: Date,
): Promise<boolean> {
  let seen: VerifyAttempt | undefined = attempt;
  for (let step = 0; step < 3 && seen !== undefined; step++) {
    if (seen.status === to) return true;
    if (!isLegalTransition(seen.status, to)) return false;
    if ((await transitionAttempt(handle, seen, to, now)) !== undefined) return true;
    seen = await attemptById(handle, { appId: attempt.app_id, id: attempt.id });
  }
  return seen?.status === to;
}

/** expired_unresolved at the recheck deadline: the one alarm line (no app_id, no fingerprint). */
export function logExpired(logger: RootLogger, attempt: VerifyAttempt): void {
  logger.error(
    {
      user_id: attempt.user_id,
      verify_date: attempt.verify_date,
      vendor_request_id: attempt.vendor_request_id,
    },
    'payout_account_verify_expired_unresolved',
  );
}

export function createPayoutAccountVerifyAttempts(
  options: PayoutAccountVerifyAttemptsOptions,
): PayoutAccountVerifyAttempts {
  const { db, clock, logger, verifier, config } = options;

  /** One setting of the app, read fresh each call (B1-13g runs this on a schedule). */
  async function setting(appId: string, key: string): Promise<number> {
    return verifySetting(await readConfig(db, appId, [key], config), key, logger);
  }

  return Object.freeze({
    async takeover(subject: PayoutVerifyAttemptSubject): Promise<void> {
      const attempt = await attemptById(db, subject);
      if (attempt?.status !== 'reserved') return;
      const inflightSeconds = await setting(subject.appId, VERIFY_INFLIGHT_KEY);
      const now = clock.now();
      if (!leaseExpired(attempt, now, inflightSeconds)) return;
      // Conditional on the row still being the reserved row read here: one taker wins.
      await transitionAttempt(db, attempt, 'unknown', now);
    },

    async recheck(subject: PayoutVerifyAttemptSubject): Promise<void> {
      const attempt = await attemptById(db, subject);
      if (attempt?.status !== 'unknown') return;
      const recheckMinutes = await setting(subject.appId, VERIFY_RECHECK_KEY);
      // The query runs outside any transaction or lock; its answer is applied by CAS only.
      const outcome = verifier === null ? 'unknown' : await queryAttempt(verifier, attempt, logger);
      const now = clock.now();
      if (outcome === 'match') {
        await transitionAttempt(db, attempt, 'matched', now);
      } else if (outcome === 'mismatch') {
        await transitionAttempt(db, attempt, 'mismatched', now);
      } else if (outcome === 'not_found') {
        await transitionAttempt(db, attempt, 'expired_unresolved', now);
      } else if (recheckDue(attempt, now, recheckMinutes)) {
        const expired = await transitionAttempt(db, attempt, 'expired_unresolved', now);
        if (expired !== undefined) logExpired(logger, expired);
      }
    },
  });
}
