// B1-04zm: order rescan scheduler (规划/02 §7.1; D10-543, D10-524). Each enabled account of a
// platform is one stream (platform, account, 'rescan', '-') with its own cursor; every timer round
// dispatches one window ('rescan-window' on the order-sync queue). The increment path is untouched.
// Settings come from order_sync.rescan.<platform>.enabled / .days (B1-04zq). Unset: jd on and 30
// days, pdd off and 90 days. days must be an integer in 1～90, anything else takes the default with
// one warn per platform per round whose only field is `key`. taobao and any platform not listed
// never rescan. A failed read skips the platform for this round: it is never taken as the default.
// D10-545: a round ends at min(now, the stream's increment cursor), read and never moved, so a tail
// the increment has not fetched yet is not reported as missed. An empty increment cursor sends
// nothing this round and moves no cursor. An account without sync_start_at is skipped before any
// cursor is read, as the increment skips it.
import type { RegisteredPlatform } from '../../union/index.ts';
import type { RescanCursorStore, SyncSchedulerDeps } from './sync-ports.ts';
import type { OrderSyncScheduler, SyncIntervalConfig } from './sync-scheduler.ts';

export interface OrderRescanSchedulerDeps extends Omit<SyncSchedulerDeps, 'cursors'> {
  readonly cursors: RescanCursorStore;
  readonly config: SyncIntervalConfig;
  /** Window cap per platform; absent → the rule table's syncWindowCapMs. */
  readonly capsMs?: Readonly<Partial<Record<RegisteredPlatform, number>>>;
}

/** One scheduling round over `platforms`; gated exactly like the increment scheduler. */
export async function scheduleOrderRescan(
  deps: OrderRescanSchedulerDeps,
  platforms: readonly RegisteredPlatform[],
): Promise<void> {
  void deps;
  void platforms;
  throw new Error('NotImplemented: scheduleOrderRescan');
}

/**
 * Starts timers only; construction and start must not dispatch a window. The timer paces on valid
 * days only: an invalid value paces as the default and warns only through the round itself.
 */
export function createOrderRescanScheduler(
  deps: OrderRescanSchedulerDeps,
  platforms: readonly RegisteredPlatform[],
): OrderSyncScheduler {
  void deps;
  void platforms;
  throw new Error('NotImplemented: createOrderRescanScheduler');
}
