// B1-03z: producer of appeal restore differences (申诉恢复差错单; 08 BR-FUND-22, BR-CALC-13 细则
// 「申诉恢复」, 拍板第二批 FUND-14; BR-ID-36 结案撤销). Skeleton of the test stage: the rule tests in
// test/spec/risk/appeal-restore/** import this file by path; the names, signatures and semantics
// written here are the contract.
//
// 1. Wiring (implementation)
//    - Consumer `risk-appeal-restore` of EVENT_SUBSCRIPTIONS (platform/events/types.ts), subscribed
//      to appeal.resolved only. Its queue `evt.risk-appeal-restore` is a standard queue of
//      QUEUE_CATALOG with the catalog defaults, right after evt.notification-claim-result; the
//      worker's ENTRY_PLAN runs it with concurrency 1 and polling 2 s (worker-plan.ts, same place);
//      no other entry consumes it.
//    - The worker entry registers the handler once through registerEventConsumer (RiskScanModule or
//      a sibling worker module, as notification-appeal-result does); without a database handle
//      nothing is registered. Assembly runs no statement and sends nothing.
//    - The ports are injected by the worker assembly (RiskScanModule.forWorker), never imported by
//      risk itself (规划/02 §4.1): `shares` = commission's listBannedForfeitedShares,
//      `bannedRunStart` = commission's findBannedRunStart, `forfeitedAmount` = the ledger read of
//      what the share's FORFEIT voucher booked to the platform.
//
// 2. createAppealRestoreHandler(options) → EventHandler(event, trx)
//    - Reads the event data of appeal.resolved {app_id, appeal_id, user_id, target_type,
//      target_id, status} (04 adminResolveAppeal; extra keys such as need_reauth are ignored).
//      A malformed event (wrong name, app_id ≠ event appId, missing / mistyped key) rejects.
//    - Acts only when target_type = account, status = revoked and the appeal row (app.appeals,
//      risk's own table) has prev_risk_state = banned. Every other event (upheld, a freeze appeal,
//      an order or blocked_request appeal) resolves with nothing written: the delivery is
//      acknowledged. Order appeals are settlement's (not this module).
//    - 「本次封禁」: from the appeal's penalty_started_at (B1-03v) to its closed_at, both inclusive.
//      Without penalty_started_at (rows from before the column): from bannedRunStart(trx,
//      { until: the appeal's created_at, notBefore: the close of the member's previous account
//      appeal that ended a ban or a freeze, else null }) to closed_at. An upheld ban appeal does
//      not end the ban.
//    - Shares: the `shares` port (reason banned only; deleted / minor never).
//    - Amount: the `forfeitedAmount` port for each share (what its FORFEIT voucher booked), never
//      the snapshot estimate. A missing port it needs (shares; forfeitedAmount when there are
//      shares; bannedRunStart without penalty_started_at) rejects; a share whose amount the port
//      answers null rejects the whole event and logs `appeal_restore_amount_unavailable` at error
//      with app_id and appeal_id. Rejecting writes nothing (queue retry, then dead letter).
//    - For each (sub-order, member) — the member's roles on one sub-order are one difference — on
//      the consumer's transaction `trx`, one ledger registerReconDiffOnce:
//        type appeal_restore; refType 'order'; refId the order key `{platform}:{sub_order_id}`,
//        or, when another difference already holds that key in the period, the order key with a
//        member-specific `#` suffix (at most 64 characters);
//        expectedFen = Σ forfeited amounts; actualFen = 0; diffFen = expectedFen − actualFen
//        (contracts AdminReconDiff); source one of R1 / R2 / R3 and period YYYY-MM or YYYY-MM-DD,
//        chosen by the implementation and written down with their basis;
//        dedupeKey containing app_id, order_id, user_id, every role and appeal_id, so a replayed
//        event (same or new event id) registers nothing new.
//    - Never posts to the ledger, never changes a balance, never appends a share event, never
//      writes appeals: the restoring ADMIN_RESTORE is the admin line's (处理前不入账).
//    - Time only from options.clock.
//
// 3. Choices of the implementation (B1-03z)
//    - source R3: AdminReconDiff's sources are R1 (union reconciliation), R2 (payout channel) and
//      R3 (internal ledger check, fund.yaml ledger_mismatch 内部日终差异). A restore is internal to
//      our books — a share kept as platform COMMISSION_REVENUE that is owed back to the member
//      (BR-FUND-22 ③) — with no union or channel party, so R3.
//    - period: chinaMonth(appeals.closed_at) (YYYY-MM, +08:00 via @couli/domain): the month the
//      revocation (BR-ID-36 结案撤销) happened. It comes from the appeal row, not the clock, so a
//      replay on another day lands on the same business key.
//    - refId: `${order_id}:${role}:${user tag}` where the user tag is the first 16 hex digits of
//      sha256(user_id): contains the sub-order id, distinct per (order_id, user_id, role), and at
//      most 36 + 1 + 8 + 1 + 16 = 62 characters (contracts AdminReconDiff ref_id maxLength 64).
//      The full ids are in dedupeKey and resolution.
//    - dedupeKey: `appeal_restore:${app_id}:${appeal_id}:${order_id}:${user_id}:${role}`.
//    - resolution: { reason_code: 'APPEAL_RESTORE', appeal_id, order_id, user_id, role,
//      forfeit_reason: 'banned', forfeited_at } for the processing admin (ADMIN_RESTORE).
//    - A share whose amount is 0 has nothing to restore: no difference is registered for it.
//    - An appeal.resolved whose appeal row is missing, or whose row disagrees with the event
//      (target, user, status), or a revoked account appeal without user_id, rejects (retry, then
//      dead letter): a money producer does not guess.
//    - Fallback window: with no banned forfeiture at or before created_at there is nothing of this
//      ban to restore and nothing is written.
//    - Shares port (options.shares): commission's listBannedForfeitedShares, injected by the
//      worker assembly (app.module → RiskScanModule.forWorker) and not imported here. commission's
//      index.ts reaches identity's index.ts (types of beneficiary-resolver / rebate-quoter), which
//      reaches risk's index.ts — an import from here would close a cycle (no-circular) and pull
//      identity's decorated controllers into the erasable `test` project. Without the port, a
//      revoked ban appeal rejects with `risk: appeal restore needs commission's shares port`
//      (retry, then dead letter) instead of reading commission's tables itself (规划/02 §4.1);
//      every other event is still acknowledged.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import { createHash } from 'node:crypto';
import type { DB } from '@couli/db';
import { chinaMonth } from '@couli/domain';
import { subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import { registerReconDiffOnce } from '../../ledger/index.ts';
import type { Clock, EventHandler, JobPayload, ReceivedEvent } from '../../platform/index.ts';

/** The consumer name of EVENT_SUBSCRIPTIONS; its queue is `evt.risk-appeal-restore`. */
export type AppealRestoreConsumer = 'risk-appeal-restore';

/** One share forfeited for a ban (commission's BannedForfeitedShare, structurally). */
export interface AppealRestoreShare {
  readonly orderId: string;
  readonly role: string;
  readonly amountFen: bigint;
  readonly forfeitedAt: Date;
}

/** commission's listBannedForfeitedShares (both window ends inclusive). */
export type BannedForfeitedSharesPort = (
  trx: Kysely<DB>,
  input: {
    readonly appId: string;
    readonly userId: string;
    readonly since: Date;
    readonly until: Date;
  },
) => Promise<readonly AppealRestoreShare[]>;

export interface AppealRestoreOptions {
  readonly clock: Clock;
  /** commission's listBannedForfeitedShares; the worker assembly always passes it (section 3). */
  readonly shares?: BannedForfeitedSharesPort;
}

/** The appeal.resolved handler that registers one appeal_restore difference per banned share. */
export function createAppealRestoreHandler(options: AppealRestoreOptions): EventHandler {
  const { clock } = options;
  return async (event, trx) => {
    const data = readPayload(event);
    if (data.target_type !== 'account' || data.status !== 'revoked') return;
    if (data.user_id === null) throw new Error('risk: revoked account appeal without user_id');
    const appeal = await trx
      .withSchema('app')
      .selectFrom('appeals')
      .select([
        'target_type',
        'user_id',
        'status',
        'prev_risk_state',
        'penalty_started_at',
        'closed_at',
        'created_at',
      ])
      .where('app_id', '=', data.app_id)
      .where('id', '=', data.appeal_id)
      .executeTakeFirst();
    if (
      appeal === undefined ||
      appeal.target_type !== 'account' ||
      appeal.user_id !== data.user_id ||
      appeal.status !== 'revoked' ||
      appeal.closed_at === null
    ) {
      throw new Error('risk: appeal.resolved does not match a revoked account appeal');
    }
    if (appeal.prev_risk_state !== 'banned') return;
    const listShares = options.shares;
    if (listShares === undefined) {
      throw new Error("risk: appeal restore needs commission's shares port");
    }
    const userId = data.user_id;
    const until = appeal.closed_at;
    const since = await windowStart(trx, listShares, data.app_id, userId, appeal);
    if (since === null) return;
    const shares = await listShares(trx, {
      appId: data.app_id,
      userId,
      since,
      until,
    });
    const period = chinaMonth(until);
    for (const share of shares) {
      if (share.amountFen === 0n) continue;
      await register(
        trx,
        clock,
        { appId: data.app_id, appealId: data.appeal_id, userId, period },
        share,
      );
    }
  };
}

const TARGET_TYPES: ReadonlySet<string> = new Set(['account', 'order', 'blocked_request']);
const STATUSES: ReadonlySet<string> = new Set(['revoked', 'upheld']);

interface AppealResolvedData {
  readonly app_id: string;
  readonly appeal_id: string;
  readonly user_id: string | null;
  readonly target_type: string;
  readonly target_id: string;
  readonly status: string;
}

/** 04 adminResolveAppeal's appeal.resolved data; extra keys (need_reauth) are ignored. */
function readPayload(event: ReceivedEvent): AppealResolvedData {
  if (event.name !== 'appeal.resolved') {
    throw new Error('risk: appeal restore consumes appeal.resolved only');
  }
  const value = event.payload as Partial<Record<keyof AppealResolvedData, unknown>>;
  if (
    value.app_id !== event.appId ||
    typeof value.appeal_id !== 'string' ||
    value.appeal_id.length === 0 ||
    !(value.user_id === null || typeof value.user_id === 'string') ||
    typeof value.target_type !== 'string' ||
    !TARGET_TYPES.has(value.target_type) ||
    typeof value.target_id !== 'string' ||
    typeof value.status !== 'string' ||
    !STATUSES.has(value.status)
  ) {
    throw new Error('risk: invalid appeal.resolved payload');
  }
  return value as AppealResolvedData;
}

/**
 * 「本次封禁」's start: penalty_started_at (B1-03v); without it, the member's most recent banned
 * forfeiture at or before the appeal's created_at (null: none, nothing to restore).
 */
async function windowStart(
  trx: Transaction<DB>,
  listShares: BannedForfeitedSharesPort,
  appId: string,
  userId: string,
  appeal: { readonly penalty_started_at: Date | null; readonly created_at: Date },
): Promise<Date | null> {
  if (appeal.penalty_started_at !== null) return appeal.penalty_started_at;
  const before = await listShares(trx, {
    appId,
    userId,
    since: epochLike(appeal.created_at),
    until: appeal.created_at,
  });
  let latest: Date | null = null;
  for (const share of before) {
    if (latest === null || share.forfeitedAt.getTime() > latest.getTime()) {
      latest = share.forfeitedAt;
    }
  }
  return latest;
}

/** 1970-01-01T00:00Z as a Date (no `new Date`: same pattern as risk/domain/appeal-deadline.ts). */
function epochLike(like: Date): Date {
  const result = structuredClone(like);
  result.setTime(0);
  return result;
}

async function register(
  trx: Transaction<DB>,
  clock: Clock,
  scope: {
    readonly appId: string;
    readonly appealId: string;
    readonly userId: string;
    readonly period: string;
  },
  share: AppealRestoreShare,
): Promise<void> {
  const userTag = createHash('sha256').update(scope.userId).digest('hex').slice(0, 16);
  const resolution: JobPayload = {
    reason_code: 'APPEAL_RESTORE',
    appeal_id: scope.appealId,
    order_id: share.orderId,
    user_id: scope.userId,
    role: share.role,
    forfeit_reason: 'banned',
    forfeited_at: share.forfeitedAt.toISOString(),
  };
  await registerReconDiffOnce(
    trx,
    {
      appId: scope.appId,
      type: 'appeal_restore',
      source: 'R3',
      period: scope.period,
      refType: 'order',
      refId: `${share.orderId}:${share.role}:${userTag}`,
      expectedFen: share.amountFen,
      actualFen: 0n,
      diffFen: subFen(share.amountFen, 0n),
      dedupeKey: `appeal_restore:${scope.appId}:${scope.appealId}:${share.orderId}:${scope.userId}:${share.role}`,
      resolution,
    },
    { clock },
  );
}
