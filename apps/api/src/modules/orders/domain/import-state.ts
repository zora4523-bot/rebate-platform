// B1-08h：子订单首次入库时的平台状态首态与 history（BR-FUND-01；specs/state-machines/order-platform.yaml
// P1、P2、P11、P12、P13）。每一步都经生成的 transitionOrderPlatform 判定，不手写状态比较。
// - P1 / P2 / P13：一条 history（null → 首态）。
// - P11（首次即已收货）：有收货时间 → PAID、RECEIVED 两条；缺收货时间 → 按 P2 落 PAID 一条，
//   收货事件进待处理表（NO_RECEIVED_AT）。结算时间不能替代收货时间。
// - P12（首次即已结算）：补写 PAID、RECEIVED、SETTLED 三条，received_at 缺时取结算时间；
//   两者都缺 → 同 P11 缺时间（待编排裁定 5 默认）。
// - 首次 RIGHTS / PUNISH 表内无合法迁移 → pending ILLEGAL_TRANSITION，不建订单行。
import { transitionOrderPlatform, type OrderPlatformState } from '@couli/domain';
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

/** Walks the generated transition table; any step that is not a real (non-noop) move is a bug. */
function walk(events: readonly PlatformStatusEvent[]): ImportHistory[] | null {
  const history: ImportHistory[] = [];
  let from: OrderPlatformState | null = null;
  for (const event of events) {
    const result = transitionOrderPlatform(from, event);
    if (!result.ok || result.noop) return null;
    history.push({ from_status: from, event, to_status: result.to });
    from = result.to;
  }
  return history;
}

function insert(
  history: ImportHistory[] | null,
  receivedAt: Date | null,
  pending: 'NO_RECEIVED_AT' | null,
): ImportStateDecision {
  const last = history?.at(-1);
  if (history === null || last === undefined) {
    return { kind: 'pending', reason: 'ILLEGAL_TRANSITION' };
  }
  return {
    kind: 'insert',
    platform_status: last.to_status,
    received_at: receivedAt,
    history,
    pending,
  };
}

export function planImportState(
  event: PlatformStatusEvent,
  receivedAt: Date | null,
  settledAt: Date | null,
): ImportStateDecision {
  const first = transitionOrderPlatform(null, event);
  if (!first.ok) return { kind: 'pending', reason: 'ILLEGAL_TRANSITION' };
  if (event === 'PLATFORM_RECEIVED' || event === 'PLATFORM_SETTLED') {
    const received = event === 'PLATFORM_RECEIVED' ? receivedAt : (receivedAt ?? settledAt);
    if (received === null) return insert(walk(['PLATFORM_PAID']), null, 'NO_RECEIVED_AT');
    const steps: PlatformStatusEvent[] =
      event === 'PLATFORM_RECEIVED'
        ? ['PLATFORM_PAID', 'PLATFORM_RECEIVED']
        : ['PLATFORM_PAID', 'PLATFORM_RECEIVED', 'PLATFORM_SETTLED'];
    return insert(walk(steps), received, null);
  }
  return insert(walk([event]), receivedAt, null);
}
