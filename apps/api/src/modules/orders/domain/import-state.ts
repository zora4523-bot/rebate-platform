import type { OrderPlatformState } from '@couli/domain';
import type { PlatformStatusEvent } from './status-map.ts';

export interface ImportHistory {
  readonly from_status: OrderPlatformState | null;
  readonly event: PlatformStatusEvent;
  readonly to_status: OrderPlatformState;
}

export type ImportStateDecision =
  | { readonly kind: 'pending'; readonly reason: 'ILLEGAL_TRANSITION' }
  | {
      readonly kind: 'insert';
      readonly platform_status: OrderPlatformState;
      readonly received_at: Date | null;
      readonly history: readonly ImportHistory[];
      readonly pending: 'NO_RECEIVED_AT' | null;
    };

export function planImportState(
  event: PlatformStatusEvent,
  receivedAt: Date | null,
  settledAt: Date | null,
): ImportStateDecision {
  void event;
  void receivedAt;
  void settledAt;
  throw new Error('NotImplemented: planImportState');
}
