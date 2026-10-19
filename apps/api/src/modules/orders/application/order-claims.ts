// B1-10b: claim acceptance (POST /v1/orders/claims) and the applicant's claim records (GET
// /v1/orders/claims) — 08 BR-ATTR-17 ⓪～④, BR-ATTR-19, BR-ATTR-13 ④, BR-ATTR-10 (share orders);
// orchestrator 口径 1～13. The HTTP layer owns contract validation, the version gate and
// idempotency; this file judges everything after them.
//
// Acceptance, in order, stopping at the first failure:
//   order_no with every U+0020 removed is empty → 20001 data.fields=[order_no] (nothing read);
//   ⓪ claims.enabled = false (content's reader; missing or unreadable reads as the registered
//      default true) → 30206, before any lock, Redis or order read, not counted;
//   then, in one transaction holding the (app_id, user_id) advisory lock before any count is read
//   (a direct call opens its own; HTTP passes platform idempotency's, createOrderClaimIn, so the
//   claim rows and the stored response commit or roll back together: Codex 资金评审 r2 S1):
//   ① the day's failure count (Redis) ≥ 10 → 30203 data.reason=RISK_BLOCKED, not counted;
//   ② claims created today (PG, +08:00 day, any status) ≥ 5 → 30203 without data, not counted;
//   ③ match in the token's app and the request platform: child number first, then parent number
//      (null parents never), share orders (buy_type=share) removed from both before deciding;
//      nothing left → 30201 (no data);
//   ④ each remaining child by sub_order_id ascending, a→f (domain/claim-rules.ts); nobody passes →
//      the first child's error.
// A request ending with a ③ or ④ code adds one failure (INCR + EXPIRE to the next 00:00 +08:00)
// while the lock is held; the add that reaches exactly 10 logs claim_fail_burst once. A request
// that creates a claim adds nothing, even when some children failed. One request counts once: a
// submission with an Idempotency-Key (its key and body) adds in the same script only when it has
// not been counted that day, so a retry after a lost Redis reply (50001, no idempotency record)
// adds nothing again (Codex 资金评审 r1 S1 ①); the same holds for a retry after a transaction that
// counted and then rolled back (process gone before COMMIT). Any Redis failure → 50001 (fail
// closed: no claim, no count of its own). Passing children go into one claim (status from
// transitionClaim(null, 'SUBMIT')) with one claim_items row each, under a savepoint so a unique
// violation leaves the caller's transaction usable; orders are never written.
// The configuration (⓪ and the window) is read before the transaction holds a pooled connection
// (readClaimSettings; content's reader may need a connection of its own).
// B1-10c (J-5): with the evidence ports (deps.evidence; app.module always assembles them), the
// same transaction then judges each item (application/claim-evidence.ts) and moves the claim from
// submitted to auto_matched / manual_review, so a successful submission answers the final status
// and no committed claim stays submitted; an evidence read error rolls everything back (50001,
// nothing counted). attr.backfill_window_hours is read with the other settings, before the
// transaction. Without the ports (direct calls only) the claim stays submitted as in B1-10b.
// Logs: flat fields only, never an order number, sub_order_id, paid_date, link_log id or (but for
// claim_fail_burst, 待裁定 3) a user id.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { accountingDate, transitionClaim } from '@couli/domain';
import type { Kysely, Transaction } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import { newUuidV7, type Clock, type RedisHandle, type RootLogger } from '../../platform/index.ts';
import {
  CLAIM_DAILY_LIMIT,
  CLAIM_FAIL_LIMIT,
  claimCompareValue,
  claimCounterDay,
  claimWindowHours,
  compareSubOrderId,
  judgeClaimChildren,
  secondsUntilNextChinaDay,
  stripClaimSpaces,
  type ClaimChildFailure,
} from '../domain/claim-rules.ts';
import { DEFAULT_BACKFILL_WINDOW_HOURS } from '../domain/claim-evidence.ts';
import {
  claimRequestId,
  createClaimFailureCounter,
  type ClaimFailureCounter,
} from '../infra/claim-counter.ts';
import {
  claimedSubOrders,
  countClaimsOn,
  findClaimOrders,
  insertClaim,
  listClaimItems,
  listClaimRecords,
  underClaimSavepoint,
  type ClaimOrderRow,
} from '../infra/claim-store.ts';
import { lockClaimUser } from '../infra/order-lock.ts';
import type { OrderSubject } from './order-queries.ts';
import {
  readClaimEvidenceWindow,
  settleClaimEvidence,
  type ClaimEvidenceFactory,
  type ClaimEvidenceOutcome,
} from './claim-evidence.ts';

export interface OrderClaimDeps {
  readonly evidence?: ClaimEvidenceFactory;
  readonly db?: Kysely<DB>;
  readonly redis?: RedisHandle;
  readonly clock: Clock;
  readonly config: ContentReader;
  readonly logger: RootLogger;
}

export type ClaimFailure = {
  readonly code: 20001 | 30201 | 30202 | 30203 | 30204 | 30205 | 30206 | 50001;
  readonly data?: { readonly reason: string } | { readonly fields: readonly string[] };
};
export type ClaimResult<T> = { readonly code: 0; readonly data: T } | ClaimFailure;
/** The HTTP request behind a submission (absent for a direct call: each call is its own request). */
export interface ClaimRequest {
  /** Its Idempotency-Key, already validated by the idempotency module. */
  readonly idempotencyKey: string;
}
/** What acceptance reads of configuration, before its transaction (readClaimSettings). */
export interface ClaimSettings {
  /** ⓪: false only for an explicit false of claims.enabled (registered default true). */
  readonly enabled: boolean;
  /** BR-ATTR-13 ④: claim.window_hours when it is a positive integer, else the default. */
  readonly windowHours: number;
  /** B1-10c: attr.backfill_window_hours (W_backfill; absent reads as the default 360). */
  readonly backfillWindowHours?: number;
}
export interface ClaimListInput {
  readonly cursor?: string;
  readonly limit?: number;
}

const ENABLED_KEY = 'claims.enabled';
const WINDOW_KEY = 'claim.window_hours';
/** Contract Limit: default 20, at most 50 (04 §5). */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** UTC instant as the cursor carries it: milliseconds or microseconds. */
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3}|\d{6})Z$/;

const UNAVAILABLE: ClaimFailure = Object.freeze({ code: 50001 });

/** Runs the acceptance's work in its transaction (its own, or the caller's). */
type InTransaction = <T>(work: (trx: Transaction<DB>) => Promise<T>) => Promise<T>;

function failureOf(failure: ClaimChildFailure | { readonly code: 30201 }): ClaimFailure {
  return failure.code === 30202
    ? { code: 30202, data: { reason: failure.reason } }
    : { code: failure.code };
}

/** A configuration value, or undefined when it is missing or cannot be read. */
async function configValue(config: ContentReader, appId: string, key: string): Promise<unknown> {
  try {
    return (await config.configValue(appId, key))?.value;
  } catch {
    return undefined;
  }
}

interface Matched {
  readonly kind: 'sub' | 'parent' | null;
  readonly children: readonly ClaimOrderRow[];
  /** Share orders removed by ③ (internal log only). */
  readonly removed: number;
}

/** ③: child number first, then parent number; share orders never take part. */
async function matchClaimOrders(
  trx: Parameters<typeof findClaimOrders>[0],
  appId: string,
  platform: string,
  orderNo: string,
): Promise<Matched> {
  const value = claimCompareValue(platform, orderNo);
  let removed = 0;
  for (const kind of ['sub', 'parent'] as const) {
    const rows = await findClaimOrders(trx, appId, platform, value, kind);
    const children = rows.filter((row) => row.buy_type !== 'share');
    removed += rows.length - children.length;
    if (children.length > 0) return { kind, children, removed };
  }
  return { kind: null, children: [], removed };
}

/**
 * ⓪ and the claim window of `appId`, read outside any transaction: the transaction must never
 * wait for a second pooled connection (the reader's) while it holds one. The window is not read
 * when ⓪ is off.
 */
export async function readClaimSettings(
  config: ContentReader,
  appId: string,
): Promise<ClaimSettings> {
  // ⓪ Only an explicit false switches submission off (registered default true).
  const enabled = (await configValue(config, appId, ENABLED_KEY)) !== false;
  if (!enabled) return { enabled, windowHours: claimWindowHours(undefined) };
  return {
    enabled,
    windowHours: claimWindowHours(await configValue(config, appId, WINDOW_KEY)),
    backfillWindowHours: await readClaimEvidenceWindow(config, appId),
  };
}

/** POST /v1/orders/claims after the HTTP stages, in a transaction of its own (the rule tests). */
export async function createOrderClaim(
  deps: OrderClaimDeps,
  subject: OrderSubject,
  input: Schema<'CreateOrderClaimRequest'>,
  request?: ClaimRequest,
): Promise<ClaimResult<Schema<'OrderClaim'>>> {
  // 20001 before anything is read.
  if (stripClaimSpaces(input.order_no) === '')
    return { code: 20001, data: { fields: ['order_no'] } };
  const settings = await readClaimSettings(deps.config, subject.app_id);
  const { db } = deps;
  return submitClaim(
    deps,
    subject,
    input,
    settings,
    request,
    db === undefined ? undefined : (work) => db.transaction().execute(work),
  );
}

/**
 * The same acceptance inside the caller's transaction `trx` (HTTP: platform idempotency's
 * transactional mode), with `settings` read before that transaction began. Everything it writes
 * goes through `trx`; a refusal writes nothing there, so the caller may commit it.
 */
export async function createOrderClaimIn(
  trx: Transaction<DB>,
  deps: OrderClaimDeps,
  subject: OrderSubject,
  input: Schema<'CreateOrderClaimRequest'>,
  settings: ClaimSettings,
  request?: ClaimRequest,
): Promise<ClaimResult<Schema<'OrderClaim'>>> {
  return submitClaim(deps, subject, input, settings, request, (work) => work(trx));
}

async function submitClaim(
  deps: OrderClaimDeps,
  subject: OrderSubject,
  input: Schema<'CreateOrderClaimRequest'>,
  settings: ClaimSettings,
  request: ClaimRequest | undefined,
  inTransaction: InTransaction | undefined,
): Promise<ClaimResult<Schema<'OrderClaim'>>> {
  const log = deps.logger.child({ module: 'orders' });
  const appId = subject.app_id;
  const orderNo = stripClaimSpaces(input.order_no);
  if (orderNo === '') return { code: 20001, data: { fields: ['order_no'] } };
  if (!settings.enabled) {
    log.info({ app_id: appId, outcome: 'disabled', code: 30206 }, 'orders.claim_submit');
    return { code: 30206 };
  }
  const { redis } = deps;
  if (inTransaction === undefined || redis === undefined) {
    log.warn({ app_id: appId, outcome: 'unavailable' }, 'orders.claim_submit');
    return UNAVAILABLE;
  }
  const windowHours = settings.windowHours;
  const counter = createClaimFailureCounter(redis, subject);
  const requestId =
    request === undefined ? undefined : claimRequestId(request.idempotencyKey, input);
  const failed = (now: Date, failure: ClaimFailure) =>
    fail(counter, log, subject, now, failure, requestId);
  let matched: Matched | undefined;
  let evidence: ClaimEvidenceOutcome | undefined;
  const result: ClaimResult<Schema<'OrderClaim'>> = await inTransaction(async (trx) => {
    await lockClaimUser(trx, appId, subject.user_id);
    const now = deps.clock.now();
    const day = claimCounterDay(now);
    let failures: number;
    try {
      failures = await counter.read(day);
    } catch {
      return UNAVAILABLE;
    }
    // ① and ② are not counted as failures.
    if (failures >= CLAIM_FAIL_LIMIT) return { code: 30203, data: { reason: 'RISK_BLOCKED' } };
    if ((await countClaimsOn(trx, subject, accountingDate(now))) >= CLAIM_DAILY_LIMIT) {
      return { code: 30203 };
    }
    matched = await matchClaimOrders(trx, appId, input.platform, orderNo);
    if (matched.kind === null) return failed(now, failureOf({ code: 30201 }));
    const children = matched.children;
    const judgement = judgeClaimChildren(children, {
      applicant: subject.user_id,
      paid_date: input.paid_date,
      now,
      windowHours,
      alreadyClaimed: await claimedSubOrders(
        trx,
        subject,
        input.platform,
        children.map((row) => row.sub_order_id),
      ),
    });
    if (judgement.failure !== null) {
      return failed(now, failureOf(judgement.failure));
    }
    const submitted = transitionClaim(null, 'SUBMIT');
    if (!submitted.ok) throw new Error('orders: claim state machine refuses SUBMIT');
    const claimId = newUuidV7(now);
    const itemIds = judgement.passed.map(() => newUuidV7(now));
    const claim = {
      id: claimId,
      subject,
      platform: input.platform,
      order_no: orderNo,
      order_no_type: matched.kind,
      paid_date: input.paid_date,
      status: submitted.to,
      now,
      items: judgement.passed.map((row, index) => ({
        id: itemIds[index]!,
        sub_order_id: row.sub_order_id,
        order_id: row.order_id,
      })),
    };
    const ports = deps.evidence;
    let status: string | null;
    if (ports === undefined) {
      status = await insertClaim(trx, claim);
    } else {
      // J-5: the evidence is settled under the same lock in the same transaction. Any error of
      // it (a port read, the product-key derivation, the write) undoes the claim rows to the
      // savepoint, so the transaction keeps nothing of this acceptance, and answers 50001 (fail
      // closed, not counted; HTTP stores no idempotency result for it).
      const settled = await underClaimSavepoint(trx, async () => {
        const inserted = await insertClaim(trx, claim);
        if (inserted === null) return null;
        return settleClaimEvidence(trx, ports(trx, deps.clock), {
          claimId,
          subject,
          platform: input.platform,
          windowHours: settings.backfillWindowHours ?? DEFAULT_BACKFILL_WINDOW_HOURS,
          now,
          items: judgement.passed.map((row, index) => ({
            id: itemIds[index]!,
            attr_at: row.attr_at,
            product_key: row.product_key,
            shop_id: row.shop_id,
            raw_item_id: row.raw_item_id,
          })),
        });
      });
      if (!settled.ok) {
        log.warn({ app_id: appId, outcome: 'evidence_unavailable' }, 'orders.claim_evidence');
        return UNAVAILABLE;
      }
      evidence = settled.value ?? undefined;
      status = settled.value === null ? null : settled.value.status;
    }
    // claim_items' unique key is the last line (not expected under the user lock): its insert is
    // undone to the savepoint and the answer is ④d's, counted while the lock is still held.
    if (status === null) return failed(now, { code: 30205 });
    const data: Schema<'OrderClaim'> = {
      claim_id: claimId,
      platform: input.platform,
      order_no: orderNo,
      paid_date: input.paid_date,
      status: status as Schema<'ClaimStatus'>,
      created_at: now.toISOString(),
      items: judgement.passed.map((row) => ({
        sub_order_id: row.sub_order_id,
        decision: null,
        reject_reason: null,
      })),
    };
    return { code: 0 as const, data };
  });
  const match = matched as Matched | undefined;
  const settled = evidence as ClaimEvidenceOutcome | undefined;
  log.info(
    {
      app_id: appId,
      outcome: result.code === 0 ? 'accepted' : 'refused',
      code: result.code,
      ...(match === undefined
        ? {}
        : {
            matched: match.kind ?? 'none',
            share_removed: match.removed,
            ...(result.code === 0 ? { items: result.data.items.length } : {}),
          }),
      ...(result.code === 0 && settled !== undefined
        ? {
            evidence_strong: settled.counts.strong,
            evidence_weak: settled.counts.weak,
            evidence_none: settled.counts.none,
          }
        : {}),
    },
    'orders.claim_submit',
  );
  return result;
}

/**
 * A ③ / ④ failure: one more failure of the day, under the caller's lock, unless this request
 * (`requestId`) was already counted that day; 50001 when Redis fails.
 */
async function fail(
  counter: ClaimFailureCounter,
  log: RootLogger,
  subject: OrderSubject,
  now: Date,
  failure: ClaimFailure,
  requestId: string | undefined,
): Promise<ClaimFailure> {
  let count: number | null;
  try {
    count = await counter.increment(claimCounterDay(now), secondsUntilNextChinaDay(now), requestId);
  } catch {
    return UNAVAILABLE;
  }
  // null: an earlier attempt of this request already added its failure. That add was below 10:
  // counts only grow within the day, so at 10 ① would have refused this retry before ③.
  if (count === CLAIM_FAIL_LIMIT) {
    // J-3: the risk event of BR-ATTR-19 (risk_hits belong to the risk line). The only line with
    // the user id (待裁定 3): a risk event without its subject cannot be followed up.
    log.warn(
      { app_id: subject.app_id, user_id: subject.user_id, outcome: failure.code },
      'claim_fail_burst',
    );
  }
  return failure;
}

type Cursor = { readonly at: string; readonly id: string };

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id]), 'utf8').toString('base64url');
}

/** Whole milliseconds as an ordinary ISO instant; a sub-millisecond time keeps microseconds. */
function cursorInstant(key: string): string {
  return /\.\d{3}000Z$/.test(key) ? `${key.slice(0, -4)}Z` : key;
}

/**
 * A cursor instant with a real calendar date and time (B1-10b r3 S2): parsed field by field, so
 * a date such as 02-30 that Date.parse would roll over to 03-02 is refused.
 */
function isCursorInstant(text: string): boolean {
  const match = INSTANT.exec(text);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= days && hour <= 23 && minute <= 59 && second <= 59;
}

function decodeCursor(cursor: string): Cursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    !isCursorInstant(parsed[0]) ||
    !UUID.test(parsed[1])
  ) {
    return null;
  }
  return { at: parsed[0], id: parsed[1] };
}

/** GET /v1/orders/claims: the subject's claims, newest first, each with its items. */
export async function listOrderClaims(
  deps: OrderClaimDeps,
  subject: OrderSubject,
  input: ClaimListInput,
): Promise<ClaimResult<Schema<'OrderClaimListData'>>> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { code: 20001, data: { fields: ['limit'] } };
  }
  let after: Cursor | undefined;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor);
    if (decoded === null) return { code: 20001, data: { fields: ['cursor'] } };
    after = decoded;
  }
  const { db } = deps;
  if (db === undefined) return UNAVAILABLE;
  const rows = await listClaimRecords(db, subject, after, limit + 1);
  const page = rows.slice(0, limit);
  const items = await listClaimItems(
    db,
    subject,
    page.map((row) => row.id),
  );
  const byClaim = new Map<string, Schema<'OrderClaim'>['items'][number][]>();
  for (const item of [...items].sort((a, b) => compareSubOrderId(a.sub_order_id, b.sub_order_id))) {
    const list = byClaim.get(item.claim_id) ?? [];
    list.push({
      sub_order_id: item.sub_order_id,
      decision: item.decision as Schema<'OrderClaim'>['items'][number]['decision'],
      reject_reason: item.reject_reason as Schema<'OrderClaim'>['items'][number]['reject_reason'],
    });
    byClaim.set(item.claim_id, list);
  }
  const last = page.at(-1);
  return {
    code: 0,
    data: {
      items: page.map((row) => ({
        claim_id: row.id,
        platform: row.platform as Schema<'PlatformCode'>,
        order_no: row.order_no,
        paid_date: row.paid_day,
        status: row.status as Schema<'ClaimStatus'>,
        created_at: row.created_at.toISOString(),
        items: byClaim.get(row.id) ?? [],
      })),
      next_cursor:
        rows.length > limit && last !== undefined
          ? encodeCursor(cursorInstant(last.created_key), last.id)
          : null,
    },
  };
}
