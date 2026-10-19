// B1-10b: claim acceptance (POST /v1/orders/claims) and the applicant's claim records (GET
// /v1/orders/claims) — 08 BR-ATTR-17 ⓪～④, BR-ATTR-19, BR-ATTR-13 ④, BR-ATTR-10 (share orders);
// orchestrator 口径 1～13. The HTTP layer owns contract validation, the version gate and
// idempotency; this file judges everything after them.
//
// Acceptance, in order, stopping at the first failure:
//   order_no with every U+0020 removed is empty → 20001 data.fields=[order_no] (nothing read);
//   ⓪ claims.enabled = false (content's reader; missing or unreadable reads as the registered
//      default true) → 30206, before any lock, Redis or order read, not counted;
//   then, in one transaction holding the (app_id, user_id) advisory lock before any count is read:
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
// adds nothing again (Codex 资金评审 r1 S1 ①). Any Redis failure → 50001 (fail closed: no claim,
// no count of its own). Passing children go into one claim (status from
// transitionClaim(null, 'SUBMIT')) with one claim_items row each; orders are never written.
// Logs: flat fields only, never an order number, sub_order_id, paid_date or (but for
// claim_fail_burst, 待裁定 3) a user id.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { accountingDate, transitionClaim } from '@couli/domain';
import type { Kysely } from 'kysely';
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
  type ClaimOrderRow,
} from '../infra/claim-store.ts';
import { lockClaimUser } from '../infra/order-lock.ts';
import type { OrderSubject } from './order-queries.ts';

export interface OrderClaimDeps {
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
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(\d{3}|\d{6})Z$/;

const UNAVAILABLE: ClaimFailure = Object.freeze({ code: 50001 });

/** Thrown inside the acceptance transaction to roll it back and answer `result`. */
class ClaimRollback extends Error {
  readonly result: ClaimFailure;
  constructor(result: ClaimFailure) {
    super('orders: claim acceptance rolled back');
    this.name = 'ClaimRollback';
    this.result = result;
  }
}

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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === '23505'
  );
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

/** POST /v1/orders/claims after the HTTP stages; shared by HTTP and the rule tests. */
export async function createOrderClaim(
  deps: OrderClaimDeps,
  subject: OrderSubject,
  input: Schema<'CreateOrderClaimRequest'>,
  request?: ClaimRequest,
): Promise<ClaimResult<Schema<'OrderClaim'>>> {
  const log = deps.logger.child({ module: 'orders' });
  const appId = subject.app_id;
  const orderNo = stripClaimSpaces(input.order_no);
  if (orderNo === '') return { code: 20001, data: { fields: ['order_no'] } };
  // ⓪ Only an explicit false switches submission off (registered default true).
  if ((await configValue(deps.config, appId, ENABLED_KEY)) === false) {
    log.info({ app_id: appId, outcome: 'disabled', code: 30206 }, 'orders.claim_submit');
    return { code: 30206 };
  }
  const { db, redis } = deps;
  if (db === undefined || redis === undefined) {
    log.warn({ app_id: appId, outcome: 'unavailable' }, 'orders.claim_submit');
    return UNAVAILABLE;
  }
  // Read before the transaction holds a pooled connection (the reader may need one of its own).
  const windowHours = claimWindowHours(await configValue(deps.config, appId, WINDOW_KEY));
  const counter = createClaimFailureCounter(redis, subject);
  const requestId =
    request === undefined ? undefined : claimRequestId(request.idempotencyKey, input);
  const failed = (now: Date, failure: ClaimFailure) =>
    fail(counter, log, subject, now, failure, requestId);
  let matched: Matched | undefined;
  let result: ClaimResult<Schema<'OrderClaim'>>;
  try {
    result = await db.transaction().execute(async (trx) => {
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
      let status: string;
      try {
        status = await insertClaim(trx, {
          id: claimId,
          subject,
          platform: input.platform,
          order_no: orderNo,
          order_no_type: matched.kind,
          paid_date: input.paid_date,
          status: submitted.to,
          now,
          items: judgement.passed.map((row) => ({
            id: newUuidV7(now),
            sub_order_id: row.sub_order_id,
            order_id: row.order_id,
          })),
        });
      } catch (error) {
        // claim_items' unique key is the last line (not expected under the user lock): the same
        // answer as ④d, counted while the lock is still held, then everything rolls back.
        if (!isUniqueViolation(error)) throw error;
        throw new ClaimRollback(await failed(now, { code: 30205 }));
      }
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
  } catch (error) {
    if (!(error instanceof ClaimRollback)) throw error;
    result = error.result;
  }
  const match = matched as Matched | undefined;
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
    !INSTANT.test(parsed[0]) ||
    Number.isNaN(Date.parse(parsed[0])) ||
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
