// B1-03z: commission's read-only port for risk's appeal restore producer (08 BR-FUND-22, BR-CALC-13
// 细则「申诉恢复」, 拍板第二批 FUND-14). Skeleton of the test stage: the rule tests in
// test/spec/risk/appeal-restore/** import this file by path; the names, signatures and semantics
// written here are the contract.
//
// listBannedForfeitedShares(trx, { appId, userId, since, until })
//   - Plain SELECTs on the given handle (the caller's transaction); writes nothing, opens no
//     connection or transaction, publishes nothing, logs nothing. Reads only commission's tables
//     (commission_split_beneficiary_events, the split snapshot tables).
//   - Returns one item per share (order_id, role) of `userId` in `appId` that has a forfeited event
//     with reason 'banned' whose created_at lies within [since, until] (both ends inclusive).
//     Forfeited events with reason 'deleted' or 'minor' are never returned (BR-CALC-13: 注销、未成年
//     导致的 forfeited 不恢复); neither are active / held events, other users or other apps.
//   - Latest-event rule (B1-03zf, 编排 D10-495 / D10-481 ②; rule tests in
//     test/spec/risk/appeal-restore-pricing/**): per share (order_id, user_id, role) only its
//     latest event counts, latest by event_seq (never created_at). A share is returned only when
//     that latest event is forfeited with reason 'banned' and lies within [since, until]; a banned
//     forfeiture later covered by an active or held event, or by a forfeiture for another reason,
//     is not returned. forfeitedAt is that latest event's created_at.
//   - amountFen: the share's value (份额金额) from the split snapshot — commission_split_amounts
//     amount_fen of (order_id, user_id, role). Which commission_version is used (suggested: the
//     largest one of the order) is the implementation's choice, written down here with its source.
//     Implementation (B1-03z): the largest commission_version that has a row for (order_id,
//     user_id, role) — the latest split of that share (04 commission_split_amounts: one row per
//     version and beneficiary). A forfeited share without any snapshot row is an inconsistency:
//     the call throws (the consumer's job retries, then dead-letters) instead of answering 0.
//     B1-03z r2 (funds review S0): this is the snapshot-time ESTIMATE of the share (only version 1
//     is ever written), not the amount booked to the platform when the share was forfeited (the
//     FORFEIT voucher, at B_credit). risk's producer does not use it as the restore amount.
//   - orderKey (B1-03z r2): the sub-order's order key `{platform}:{sub_order_id}` (@couli/domain
//     orderKey, from order_keys — read the same way rule-publication-store reads the platform),
//     the ref_id of recon_diffs rows about an order (ledger ReconDiffSelection.orderKey).
//   - forfeitedAt: created_at of that forfeited event (the latest one in the window when there are
//     several for the same share).
//   - orderKey: the sub-order's order key `{platform}:{sub_order_id}` (order_keys of order_id), the
//     key of its FORFEIT voucher and the restore difference's ref_id.
//   - Order: forfeitedAt ascending, then orderId, then role. Nothing found: [].
//
// findBannedRunStart(trx, { appId, userId, until, notBefore })
//   - Plain SELECTs on the given handle, like listBannedForfeitedShares; writes nothing.
//   - The start of the member's last unbroken run of banned forfeitures among the member's share
//     events (commission_split_beneficiary_events of `userId` in `appId`) with created_at in
//     (notBefore, until] — notBefore exclusive (null: no lower bound), until inclusive. Any other
//     share event of the member (active, held, forfeited with reason deleted / minor) breaks the
//     run; other members' events never join or break it. Returns the created_at of the run's
//     earliest banned forfeiture; no banned forfeiture in (notBefore, until] → null.
//   - Used by risk's appeal restore producer for appeals without penalty_started_at (存量).
//
// findBannedRunStart(trx, { appId, userId, until, notBefore }) (B1-03z r2, funds review S1)
//   - 「本次封禁」's start for an appeal without penalty_started_at: the created_at of the earliest
//     forfeited (banned) event of the member's last unbroken run of banned forfeitures at or
//     before `until` (the appeal's created_at). Walking the member's share events (every order and
//     role, by created_at then event_seq) back from the latest banned forfeiture, the run stops at
//     the first event that is not a banned forfeiture: an active or held event, or a forfeiture
//     for another reason (deleted / minor). A held event means the member was frozen or appealing
//     (not banned) when that share was credited; an active event is a snapshot or a restore. Events
//     before `notBefore` (exclusive; null: none) are not looked at: the caller passes the close of
//     the member's previous appeal that ended a ban or a freeze.
//   - null when there is no banned forfeiture in (notBefore, until].
//   - Plain SELECTs on the given handle, commission's events table only.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { DB } from '@couli/db';
import { orderKey } from '@couli/domain';
import type { Kysely } from 'kysely';

const ROLES: ReadonlySet<string> = new Set(['self', 'share', 'direct', 'indirect']);

/** Beneficiary roles of commission_split_beneficiary_events (推广 / 自购份额). */
export type ForfeitedShareRole = 'self' | 'share' | 'direct' | 'indirect';

export interface ListBannedForfeitedSharesInput {
  readonly appId: string;
  readonly userId: string;
  /** Inclusive lower bound of the forfeited event's created_at. */
  readonly since: Date;
  /** Inclusive upper bound of the forfeited event's created_at. */
  readonly until: Date;
}

export interface BannedForfeitedShare {
  readonly orderId: string;
  /** The sub-order's order key `{platform}:{sub_order_id}` (order_keys). */
  readonly orderKey: string;
  readonly role: ForfeitedShareRole;
  /** The share's snapshot-time estimate in fen (split snapshot v1), not the forfeited amount. */
  readonly amountFen: bigint;
  /** created_at of the share's forfeited (banned) event inside the window. */
  readonly forfeitedAt: Date;
}

/** BR-CALC-13 细则「申诉恢复」: the user's shares forfeited for a ban within [since, until]. */
export async function listBannedForfeitedShares(
  trx: Kysely<DB>,
  input: ListBannedForfeitedSharesInput,
): Promise<readonly BannedForfeitedShare[]> {
  const db = trx.withSchema('app');
  // Latest-event rule (D10-481 ②): the latest event of each share by event_seq first, the window
  // and the banned forfeiture checked on that latest event only. Candidates are the orders with a
  // banned forfeiture of the member in the window (a superset: a listed share's latest event is one).
  const latestEvents = await db
    .selectFrom('commission_split_beneficiary_events')
    .distinctOn(['order_id', 'role'])
    .select(['order_id', 'role', 'status', 'reason', 'created_at'])
    .where('app_id', '=', input.appId)
    .where('user_id', '=', input.userId)
    .where('order_id', 'in', (eb) =>
      eb
        .selectFrom('commission_split_beneficiary_events')
        .select('order_id')
        .where('app_id', '=', input.appId)
        .where('user_id', '=', input.userId)
        .where('status', '=', 'forfeited')
        .where('reason', '=', 'banned')
        .where('created_at', '>=', input.since)
        .where('created_at', '<=', input.until),
    )
    .orderBy('order_id')
    .orderBy('role')
    .orderBy('event_seq', 'desc')
    .execute();
  const forfeited = latestEvents
    .filter(
      (row) =>
        row.status === 'forfeited' &&
        row.reason === 'banned' &&
        row.created_at.getTime() >= input.since.getTime() &&
        row.created_at.getTime() <= input.until.getTime(),
    )
    .map((row) => ({ order_id: row.order_id, role: row.role, forfeited_at: row.created_at }));
  if (forfeited.length === 0) return [];
  const amounts = await db
    .selectFrom('commission_split_amounts')
    .select(['order_id', 'role', 'commission_version', 'amount_fen'])
    .where('app_id', '=', input.appId)
    .where('user_id', '=', input.userId)
    .where(
      'order_id',
      'in',
      forfeited.map((row) => row.order_id),
    )
    .execute();
  const keys = await db
    .selectFrom('order_keys')
    .select(['order_id', 'platform', 'sub_order_id'])
    .where('app_id', '=', input.appId)
    .where(
      'order_id',
      'in',
      forfeited.map((row) => row.order_id),
    )
    .execute();
  const keyOf = new Map(
    keys.map((row) => [row.order_id, orderKey(row.platform, row.sub_order_id)]),
  );
  const latest = new Map<string, { version: number; amountFen: bigint }>();
  for (const row of amounts) {
    const key = `${row.order_id}:${row.role}`;
    const seen = latest.get(key);
    if (seen === undefined || row.commission_version > seen.version) {
      latest.set(key, { version: row.commission_version, amountFen: row.amount_fen });
    }
  }
  const shares = forfeited.map((row): BannedForfeitedShare => {
    if (!ROLES.has(row.role)) {
      throw new Error('commission: forfeited share with an unknown role');
    }
    const amount = latest.get(`${row.order_id}:${row.role}`);
    if (amount === undefined) {
      throw new Error('commission: forfeited share without a split snapshot amount');
    }
    const key = keyOf.get(row.order_id);
    if (key === undefined) {
      throw new Error('commission: forfeited share without an order key');
    }
    return {
      orderId: row.order_id,
      orderKey: key,
      role: row.role as ForfeitedShareRole,
      amountFen: amount.amountFen,
      forfeitedAt: row.forfeited_at,
    };
  });
  return shares.sort(
    (a, b) =>
      a.forfeitedAt.getTime() - b.forfeitedAt.getTime() ||
      compare(a.orderId, b.orderId) ||
      compare(a.role, b.role),
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface FindBannedRunStartInput {
  readonly appId: string;
  readonly userId: string;
  /** Inclusive upper bound (the appeal's created_at). */
  readonly until: Date;
  /** Exclusive lower bound; null: from the member's first event. */
  readonly notBefore: Date | null;
}

/** BR-CALC-13 细则「申诉恢复」, appeals without penalty_started_at: start of the last banned run. */
export async function findBannedRunStart(
  trx: Kysely<DB>,
  input: FindBannedRunStartInput,
): Promise<Date | null> {
  let query = trx
    .withSchema('app')
    .selectFrom('commission_split_beneficiary_events')
    .select(['status', 'reason', 'created_at'])
    .where('app_id', '=', input.appId)
    .where('user_id', '=', input.userId)
    .where('created_at', '<=', input.until);
  if (input.notBefore !== null) query = query.where('created_at', '>', input.notBefore);
  const events = await query.orderBy('created_at', 'desc').orderBy('event_seq', 'desc').execute();
  let start: Date | null = null;
  for (const event of events) {
    const banned = event.status === 'forfeited' && event.reason === 'banned';
    if (banned) {
      start = event.created_at;
      continue;
    }
    // Before the first banned forfeiture (walking back) other events are after the run: skip.
    if (start !== null) break;
  }
  return start;
}
