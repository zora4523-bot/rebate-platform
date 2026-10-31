// B2-09ga: the one judgement of 「该受益人份额是否被剥夺」 (编排裁定 D10-481 ②; 08 BR-FUND-22 ③, BR-CALC-09,
// BR-CALC-13).
//
// isShareForfeited(initialStatus, events)
//   - Pure: no I/O, no clock; never changes its input (the list may be frozen).
//   - initialStatus: beneficiaries[].initial_status of the immutable commission_splits row.
//   - events: the commission_split_beneficiary_events of ONE share (order_id, user_id, role), in any
//     order. event_seq alone decides which is the latest (compared as bigint, never created_at).
//   - No events → initialStatus === 'forfeited'. Otherwise latest.status === 'forfeited': an active
//     or a held event as the latest one means the share is not forfeited. Reasons do not matter.
//
// Settlement cannot import this file (modules-only-via-index) nor value-import commission/index.ts
// from its funds paths (its graph reaches Nest modules the `test` project cannot compile), so the
// reads answer with it: forfeited-state-read.ts.
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
  let latest: ShareEvent | undefined;
  for (const event of events) {
    if (latest === undefined || event.eventSeq > latest.eventSeq) latest = event;
  }
  return latest === undefined ? initialStatus === 'forfeited' : latest.status === 'forfeited';
}
