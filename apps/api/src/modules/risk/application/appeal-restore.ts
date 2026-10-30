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
//      Without penalty_started_at (rows from before the column): from the user's most recent
//      banned forfeiture at or before the appeal's created_at, to closed_at.
//    - Shares: commission's listBannedForfeitedShares (reason banned only; deleted / minor never).
//    - For each share, on the consumer's transaction `trx`, one ledger registerReconDiffOnce:
//        type appeal_restore; refType 'order'; refId pointing at the sub-order — it contains the
//        order_id and is distinct per (order_id, user_id, role) so that two members' shares of one
//        order never meet on the business key (app_id, type, period, ref_id);
//        expectedFen = the share's amount; actualFen = 0; diffFen = expectedFen − actualFen
//        (contracts AdminReconDiff); source one of R1 / R2 / R3 and period YYYY-MM or YYYY-MM-DD,
//        chosen by the implementation and written down with their basis;
//        dedupeKey containing app_id, order_id, user_id, role and appeal_id, so a replayed event
//        (same or new event id) registers nothing new.
//    - Never posts to the ledger, never changes a balance, never appends a share event, never
//      writes appeals: the restoring ADMIN_RESTORE is the admin line's (处理前不入账).
//    - Time only from options.clock.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { Clock, EventHandler } from '../../platform/index.ts';

/** The consumer name of EVENT_SUBSCRIPTIONS; its queue is `evt.risk-appeal-restore`. */
export type AppealRestoreConsumer = 'risk-appeal-restore';

export interface AppealRestoreOptions {
  readonly clock: Clock;
}

/** The appeal.resolved handler that registers one appeal_restore difference per banned share. */
export function createAppealRestoreHandler(options: AppealRestoreOptions): EventHandler {
  void options;
  throw new Error('NotImplemented: createAppealRestoreHandler');
}
