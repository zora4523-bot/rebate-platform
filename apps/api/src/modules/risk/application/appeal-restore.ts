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
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, EventHandler } from '../../platform/index.ts';

/** The consumer name of EVENT_SUBSCRIPTIONS; its queue is `evt.risk-appeal-restore`. */
export type AppealRestoreConsumer = 'risk-appeal-restore';

/** Beneficiary roles of a share (推广 / 自购份额). */
export type AppealRestoreShareRole = 'self' | 'share' | 'direct' | 'indirect';

/** One banned forfeited share as the `shares` port answers it (commission). */
export interface AppealRestoreShare {
  readonly orderId: string;
  /** The sub-order's order key `{platform}:{sub_order_id}`. */
  readonly orderKey: string;
  readonly role: AppealRestoreShareRole;
  /** The split snapshot's value of the share (an estimate; never the restored amount). */
  readonly amountFen: bigint;
  readonly forfeitedAt: Date;
}

export interface AppealRestoreSharesInput {
  readonly appId: string;
  readonly userId: string;
  /** Inclusive. */
  readonly since: Date;
  /** Inclusive. */
  readonly until: Date;
}

/** The member's shares forfeited for a ban within [since, until] (commission). */
export type AppealRestoreSharesPort = (
  trx: Kysely<DB>,
  input: AppealRestoreSharesInput,
) => Promise<readonly AppealRestoreShare[]>;

export interface BannedRunStartInput {
  readonly appId: string;
  readonly userId: string;
  /** Inclusive. */
  readonly until: Date;
  /** Exclusive; null: no lower bound. */
  readonly notBefore: Date | null;
}

/** Start of the member's last unbroken run of banned forfeitures (commission). */
export type BannedRunStartPort = (
  trx: Kysely<DB>,
  input: BannedRunStartInput,
) => Promise<Date | null>;

export interface ForfeitedAmountInput {
  readonly appId: string;
  readonly orderId: string;
  /** The FORFEIT voucher's order key `{platform}:{sub_order_id}`. */
  readonly orderKey: string;
  readonly userId: string;
  readonly role: AppealRestoreShareRole;
}

/**
 * What the share's FORFEIT voucher `{order_key}:PLATFORM:FORFEIT:{uid}:{role}` booked to the
 * platform, in fen; null when the ledger has no such voucher (ledger read, on the given handle).
 */
export type ForfeitedAmountPort = (
  trx: Kysely<DB>,
  input: ForfeitedAmountInput,
) => Promise<bigint | null>;

/** The producer's logger (a pino logger fits). */
export interface AppealRestoreLogger {
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface AppealRestoreOptions {
  readonly clock: Clock;
  readonly shares?: AppealRestoreSharesPort;
  readonly bannedRunStart?: BannedRunStartPort;
  readonly forfeitedAmount?: ForfeitedAmountPort;
  readonly logger?: AppealRestoreLogger;
}

/** The appeal.resolved handler that registers one appeal_restore difference per banned share. */
export function createAppealRestoreHandler(options: AppealRestoreOptions): EventHandler {
  void options;
  throw new Error('NotImplemented: createAppealRestoreHandler');
}
