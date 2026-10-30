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
//      Without penalty_started_at (rows from before the column): see section 3 (r2).
//    - Shares: commission's listBannedForfeitedShares (reason banned only; deleted / minor never).
//    - For each share, on the consumer's transaction `trx`, one ledger registerReconDiffOnce:
//        type appeal_restore; refType 'order'; refId pointing at the sub-order — it contains the
//        order_id and is distinct per (order_id, user_id, role) so that two members' shares of one
//        order never meet on the business key (app_id, type, period, ref_id);
//        expectedFen = the share's amount; actualFen = 0; diffFen = expectedFen − actualFen
//        (contracts AdminReconDiff); source one of R1 / R2 / R3 and period YYYY-MM or YYYY-MM-DD,
//        chosen by the implementation and written down with their basis;
//        dedupeKey containing app_id, order_id, user_id, every role and appeal_id, so a replayed
//        event (same or new event id) registers nothing new.
//    - Never posts to the ledger, never changes a balance, never appends a share event, never
//      writes appeals: the restoring ADMIN_RESTORE is the admin line's (处理前不入账).
//    - Time only from options.clock.
//
// 3. Choices of the implementation (B1-03z; r2 after the funds review)
//    - Amount (r2, review S0): the amount the forfeiture actually booked to the platform — the
//      FORFEIT voucher `{order_key}:PLATFORM:FORFEIT:{uid}:{role}` (BR-CALC-13; R5 and R5a share the
//      key), whose value was computed at B_credit, not the snapshot estimate. It comes from the
//      injected port options.forfeitedAmount (a ledger read: risk never reads ledger tables).
//      Without the port, or when it answers null (no such voucher), a revoked ban appeal with
//      shares rejects and logs `appeal_restore_amount_unavailable` (error): nothing is registered
//      and the snapshot value is never used instead.
//      TODO(规划/11 §2.3): ledger 导出按 uniq_key 读 FORFEIT 凭证金额的只读接口，并在 app.module 注入
//      forfeitedAmount — blocked on ledger 路径不在 B1-03z 任务范围内
//    - One difference per (sub-order, member) of the appeal (r2, review S2): ref_type 'order',
//      ref_id = the order key (ledger ReconDiffSelection.orderKey, so getReconDiffs({ orderKey })
//      and the admin ref_id filter find it); expected_fen = Σ of the member's forfeited amounts on
//      that sub-order (one per role, usually one), each listed in resolution.shares. recon_diffs'
//      business key is UNIQUE (app_id, type, period, ref_id): when another member's (or an order
//      appeal's) difference already holds that key in the same period, the row is registered
//      under ref_id `${order_key}#${first 12 hex of sha256(user_id)}` instead (≤ 64 characters,
//      contracts AdminReconDiff; longer → reject), so no share is merged away.
//    - dedupeKey: `appeal_restore:${app_id}:${appeal_id}:${order_id}:${user_id}:${roles joined by
//      '+', sorted}`; a replay finds its row by it before any business-key fallback.
//    - resolution: { reason_code: 'APPEAL_RESTORE', appeal_id, order_id, order_key, user_id,
//      forfeit_reason: 'banned', shares: [{ role, amount_fen (string), forfeited_at }] }.
//    - source R3: AdminReconDiff's sources are R1 (union reconciliation), R2 (payout channel) and
//      R3 (internal ledger check, fund.yaml ledger_mismatch 内部日终差异). A restore is internal to
//      our books (a share kept as platform COMMISSION_REVENUE owed back to the member, BR-FUND-22
//      ③) with no union or channel party, so R3.
//    - period: chinaMonth(appeals.closed_at) (YYYY-MM, +08:00): from the appeal row, not the clock.
//    - A forfeited amount of 0 is not registered; neither is a sub-order whose sum is 0.
//    - Window without penalty_started_at (r2, review S1): from commission's findBannedRunStart
//      (options.bannedRunStart): the earliest banned forfeiture of the member's last unbroken run
//      of banned forfeitures at or before the appeal's created_at, the run broken by any active or
//      held share event or a forfeiture for another reason; not before the close of the member's
//      previous account appeal that ended a ban or a freeze (risk's own appeals: every closed
//      account appeal except an upheld ban). No run: nothing to restore. Without the port, such an
//      appeal rejects.
//    - An appeal.resolved whose appeal row is missing, or whose row disagrees with the event
//      (target, user, status), or a revoked account appeal without user_id, rejects (retry, then
//      dead letter): a money producer does not guess.
//    - Ports (options.shares, bannedRunStart, forfeitedAmount) are injected by the worker assembly
//      (app.module → RiskScanModule.forWorker) and not imported here: commission's index.ts reaches
//      identity's index.ts, which reaches risk's index.ts (no-circular), and would pull identity's
//      decorated controllers into the erasable `test` project. Without the shares port, a revoked
//      ban appeal rejects (`risk: appeal restore needs commission's shares port`); every other
//      event is still acknowledged.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import { createHash } from 'node:crypto';
import type { DB } from '@couli/db';
import { chinaMonth } from '@couli/domain';
import { addFen, subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import { registerReconDiffOnce, type RegisterReconDiffInput } from '../../ledger/index.ts';
import type { Clock, EventHandler, JobPayload, ReceivedEvent } from '../../platform/index.ts';

/** The consumer name of EVENT_SUBSCRIPTIONS; its queue is `evt.risk-appeal-restore`. */
export type AppealRestoreConsumer = 'risk-appeal-restore';

/** One share forfeited for a ban (commission's BannedForfeitedShare, structurally). */
export interface AppealRestoreShare {
  readonly orderId: string;
  /** The sub-order's order key; required by the producer (r2). */
  readonly orderKey?: string;
  readonly role: string;
  /** commission's snapshot estimate: not used as the restore amount (section 3). */
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

/** commission's findBannedRunStart (appeals without penalty_started_at). */
export type BannedRunStartPort = (
  trx: Kysely<DB>,
  input: {
    readonly appId: string;
    readonly userId: string;
    readonly until: Date;
    readonly notBefore: Date | null;
  },
) => Promise<Date | null>;

/**
 * The amount the share's FORFEIT voucher `{order_key}:PLATFORM:FORFEIT:{uid}:{role}` booked to
 * COMMISSION_REVENUE (a ledger read); null when there is no such voucher.
 */
export type ForfeitedAmountPort = (
  trx: Kysely<DB>,
  input: {
    readonly appId: string;
    readonly orderKey: string;
    readonly userId: string;
    readonly role: string;
  },
) => Promise<bigint | null>;

export interface AppealRestoreLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

export interface AppealRestoreOptions {
  readonly clock: Clock;
  /** commission's listBannedForfeitedShares; the worker assembly always passes it (section 3). */
  readonly shares?: BannedForfeitedSharesPort;
  /** commission's findBannedRunStart (section 3). */
  readonly bannedRunStart?: BannedRunStartPort;
  /** ledger's FORFEIT voucher amount (section 3; not yet exported by ledger). */
  readonly forfeitedAmount?: ForfeitedAmountPort;
  readonly logger?: AppealRestoreLogger;
}

/** The appeal.resolved handler that registers appeal_restore differences of a revoked ban. */
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
    const since =
      appeal.penalty_started_at ??
      (await legacyStart(trx, options, {
        appId: data.app_id,
        appealId: data.appeal_id,
        userId,
        createdAt: appeal.created_at,
      }));
    if (since === null) return;
    const shares = await listShares(trx, { appId: data.app_id, userId, since, until });
    if (shares.length === 0) return;
    const scope = {
      appId: data.app_id,
      appealId: data.appeal_id,
      userId,
      period: chinaMonth(until),
    };
    for (const group of await priced(trx, options, scope, shares)) {
      await register(trx, clock, scope, group);
    }
  };
}

const TARGET_TYPES: ReadonlySet<string> = new Set(['account', 'order', 'blocked_request']);
const STATUSES: ReadonlySet<string> = new Set(['revoked', 'upheld']);
/** contracts AdminReconDiff ref_id maxLength. */
const REF_ID_MAX = 64;

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
 * 「本次封禁」's start without penalty_started_at (section 3): commission's last banned run before
 * the appeal was filed, not reaching before the member's previous account appeal that ended a ban
 * or a freeze. null: nothing of this ban to restore.
 */
async function legacyStart(
  trx: Transaction<DB>,
  options: AppealRestoreOptions,
  input: {
    readonly appId: string;
    readonly appealId: string;
    readonly userId: string;
    readonly createdAt: Date;
  },
): Promise<Date | null> {
  const runStart = options.bannedRunStart;
  if (runStart === undefined) {
    throw new Error("risk: appeal restore needs commission's banned run port");
  }
  const previous = await trx
    .withSchema('app')
    .selectFrom('appeals')
    .select((eb) => eb.fn.max('closed_at').as('closed_at'))
    .where('app_id', '=', input.appId)
    .where('user_id', '=', input.userId)
    .where('target_type', '=', 'account')
    .where('id', '<>', input.appealId)
    .where('closed_at', 'is not', null)
    .where('closed_at', '<', input.createdAt)
    // An upheld ban appeal leaves the member banned: the same ban goes on.
    .where((eb) =>
      eb.not(eb.and([eb('status', '=', 'upheld'), eb('prev_risk_state', '=', 'banned')])),
    )
    .executeTakeFirst();
  return runStart(trx, {
    appId: input.appId,
    userId: input.userId,
    until: input.createdAt,
    notBefore: previous?.closed_at ?? null,
  });
}

interface PricedShare {
  readonly role: string;
  readonly amountFen: bigint;
  readonly forfeitedAt: Date;
}

interface OrderGroup {
  readonly orderId: string;
  readonly orderKey: string;
  readonly shares: readonly PricedShare[];
  readonly totalFen: bigint;
}

/** The forfeited amount of every share from the FORFEIT voucher, grouped by sub-order. */
async function priced(
  trx: Transaction<DB>,
  options: AppealRestoreOptions,
  scope: { readonly appId: string; readonly appealId: string; readonly userId: string },
  shares: readonly AppealRestoreShare[],
): Promise<OrderGroup[]> {
  const groups = new Map<string, { orderKey: string; shares: PricedShare[] }>();
  for (const share of shares) {
    const orderKey = share.orderKey;
    if (orderKey === undefined || orderKey.length === 0) {
      throw new Error('risk: appeal restore needs the order key of every share');
    }
    const amount =
      options.forfeitedAmount === undefined
        ? null
        : await options.forfeitedAmount(trx, {
            appId: scope.appId,
            orderKey,
            userId: scope.userId,
            role: share.role,
          });
    if (amount === null) {
      options.logger?.error(
        {
          app_id: scope.appId,
          appeal_id: scope.appealId,
          order_id: share.orderId,
          role: share.role,
          port: options.forfeitedAmount !== undefined,
        },
        'appeal_restore_amount_unavailable',
      );
      throw new Error('risk: the forfeited amount of a share is unavailable');
    }
    if (amount < 0n) throw new Error('risk: a forfeited amount is negative');
    if (amount === 0n) continue;
    const group = groups.get(share.orderId) ?? { orderKey, shares: [] };
    group.shares.push({ role: share.role, amountFen: amount, forfeitedAt: share.forfeitedAt });
    groups.set(share.orderId, group);
  }
  return [...groups.entries()].map(([orderId, group]) => {
    const sorted = [...group.shares].sort((a, b) =>
      a.role < b.role ? -1 : a.role > b.role ? 1 : 0,
    );
    return {
      orderId,
      orderKey: group.orderKey,
      shares: sorted,
      totalFen: sorted.reduce((sum, share) => addFen(sum, share.amountFen), 0n),
    };
  });
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
  group: OrderGroup,
): Promise<void> {
  const roles = group.shares.map((share) => share.role).join('+');
  const dedupeKey = `appeal_restore:${scope.appId}:${scope.appealId}:${group.orderId}:${scope.userId}:${roles}`;
  const resolution: JobPayload = {
    reason_code: 'APPEAL_RESTORE',
    appeal_id: scope.appealId,
    order_id: group.orderId,
    order_key: group.orderKey,
    user_id: scope.userId,
    forfeit_reason: 'banned',
    shares: group.shares.map((share) => ({
      role: share.role,
      amount_fen: share.amountFen.toString(),
      forfeited_at: share.forfeitedAt.toISOString(),
    })),
  };
  const input = (refId: string): RegisterReconDiffInput => {
    if (refId.length > REF_ID_MAX) throw new Error('risk: appeal restore ref_id is too long');
    return {
      appId: scope.appId,
      type: 'appeal_restore',
      source: 'R3',
      period: scope.period,
      refType: 'order',
      refId,
      expectedFen: group.totalFen,
      actualFen: 0n,
      diffFen: subFen(group.totalFen, 0n),
      dedupeKey,
      resolution,
    };
  };
  const first = await registerReconDiffOnce(trx, input(group.orderKey), { clock });
  if (first.row.dedupe_key === dedupeKey) return;
  // The business key (app_id, type, period, order key) belongs to another difference: register
  // this member's restore under a member-specific ref_id instead of merging it away.
  const tag = createHash('sha256').update(scope.userId).digest('hex').slice(0, 12);
  const second = await registerReconDiffOnce(trx, input(`${group.orderKey}#${tag}`), { clock });
  if (second.row.dedupe_key !== dedupeKey) {
    throw new Error('risk: appeal restore business key is taken by another difference');
  }
}
