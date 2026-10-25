// B1-09i: pure rules of the console's manual order sync (01 F-ORD-10; 02 §7.1). No Nest, no I/O.
// - manualSyncFilterDigest: the sha256 hex digest of the normalised filter (platform, mode, the
//   window or the order numbers, status_filter) that order_sync_requests.filter_digest stores and the
//   window jobs' singletonKey carries (`platform:account:kind:scene:manual:<digest>:window_start`).
//   Equal filters give equal digests whatever offset the instants were written in.
// - manualSyncLimits: per platform, the earliest window start the farthest look-back range of 02 §7.1
//   allows at `now` (taobao 90 days, jd 30 days, pdd 90 days) and the most order numbers one request
//   may carry (50, 01 F-ORD-10). GET /admin/v1/order-syncs/limits returns it and POST checks it.
import type { RegisteredPlatform } from '../../union/index.ts';

/** The filter of one manual sync request, as the console sent it. */
export type ManualSyncFilter =
  | {
      readonly platform: RegisteredPlatform;
      readonly mode: 'window';
      readonly from: string;
      readonly to: string;
      readonly status_filter: string | null;
    }
  | {
      readonly platform: RegisteredPlatform;
      readonly mode: 'order_nos';
      readonly order_nos: readonly string[];
    };

/** The manual sync limits of one platform (contract AdminOrderSyncPlatformLimit). */
export interface ManualSyncPlatformLimit {
  readonly platform: RegisteredPlatform;
  readonly earliest_from: string;
  readonly max_order_nos: number;
}

export function manualSyncFilterDigest(filter: ManualSyncFilter): string {
  void filter;
  throw new Error('NotImplemented: manualSyncFilterDigest');
}

export function manualSyncLimits(now: Date): readonly ManualSyncPlatformLimit[] {
  void now;
  throw new Error('NotImplemented: manualSyncLimits');
}
