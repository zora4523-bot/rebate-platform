// B2-09ga: the one judgement of 「该受益人份额是否被剥夺」 (编排裁定 D10-481 ②; 08 BR-FUND-22 ③, BR-CALC-09,
// BR-CALC-13). Skeleton of the test stage: the rule tests in test/spec/settlement/forfeited-state/**
// import this file by path; the names, signatures and semantics written here are the contract.
//
// isShareForfeited(initialStatus, events)
//   - Pure: no I/O, no clock; never changes its input (the list may be frozen).
//   - initialStatus: beneficiaries[].initial_status of the immutable commission_splits row.
//   - events: the commission_split_beneficiary_events of ONE share (order_id, user_id, role), in any
//     order. event_seq alone decides which is the latest (compared as bigint, never created_at).
//   - No events → initialStatus === 'forfeited'. Otherwise latest.status === 'forfeited': an active
//     or a held event as the latest one means the share is not forfeited. Reasons do not matter.
//
// Exported through commission/index.ts as well; clawback-order, credit-order, beneficiary-credit and
// pending-earnings-rules use this judgement instead of `initialStatus === 'forfeited' || listed`.
// What the frozen tests leave open for the wiring (none of them may change in this task):
//   - test/spec/commission/snapshot-read [AC-B2-04i#1 #5 #14] compare the whole read result and each
//     beneficiary with toEqual: an unrestored order's result gets no new defined key.
//   - read-attribution.test.ts: all-active beneficiaries take exactly two SELECTs, and its fake event
//     rows carry no status column.
//   - beneficiaries[].initialStatus stays the snapshot's value (BR-CALC-10).
//   - splitPendingShares(base, [{ initialStatus: 'forfeited' }], []) stays forfeited, and earnings.ts
//     (outside this task's paths) keeps passing (snapshot.beneficiaries, snapshot.forfeitedEvents).
//   - The frozen kits build the settlement services with today's dependencies, and files they reach
//     cannot value-import commission/index.ts: its graph reaches identity's Nest modules, which the
//     erasable-syntax `test` project cannot compile.
//
// Also compiled by the `test` project: erasable syntax only.

/** beneficiaries[].initial_status of the snapshot. */
export type ShareInitialStatus = 'active' | 'forfeited';

/** commission_split_beneficiary_events.status. */
export type ShareEventStatus = 'active' | 'held' | 'forfeited';

/** One event of a share. */
export interface ShareEvent {
  readonly eventSeq: bigint;
  readonly status: ShareEventStatus;
}

/** D10-481 ②: the initial status is the start, the latest event by event_seq decides. */
export function isShareForfeited(
  initialStatus: ShareInitialStatus,
  events: readonly ShareEvent[],
): boolean {
  void initialStatus;
  void events;
  throw new Error('NotImplemented: isShareForfeited');
}
