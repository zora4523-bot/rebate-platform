// B2-04la：找回通过 / 后台指派的纯判定（BR-FUND-01 迁移表 R3、R3b；R14 不开放）。不读库、不读时钟；
// 状态合法性只经生成的 transitionOrderRebate（rebate/domain/rules.ts 的 step）。
import type { OrderRebateEvent, OrderRebateState } from '@couli/domain';
import { isRebateState, step, type RebateStep } from '../rebate/domain/rules.ts';

export type AttributionEvent = Extract<OrderRebateEvent, 'CLAIM_APPROVED' | 'ADMIN_REASSIGN'>;

/** 判定所需的写前快照列。 */
export interface AttributionBefore {
  readonly rebate_status: string;
  readonly locked: boolean;
  readonly user_id: string | null;
}

export type AttributionDecision =
  /** R3：UNATTRIBUTED → ESTIMATED（平台已收货 / 结算时调用方再按 R4 判定 WAITING）。 */
  | { readonly kind: 'R3'; readonly step: RebateStep }
  /** R3b：VOID 不变，只置 locked。 */
  | { readonly kind: 'R3b'; readonly step: RebateStep }
  | { readonly kind: 'illegal'; readonly detail: string };

export function decideAttribution(
  before: AttributionBefore,
  event: AttributionEvent,
): AttributionDecision {
  const from = before.rebate_status;
  if (!isRebateState(from)) return { kind: 'illegal', detail: 'unknown stored rebate_status' };
  // R14（已归属订单改派）不开放：只受理 UNATTRIBUTED（R3）与 VOID（R3b）。
  if (from !== 'UNATTRIBUTED' && from !== 'VOID') {
    return { kind: 'illegal', detail: 'only R3 / R3b are accepted' };
  }
  const next = step(from satisfies OrderRebateState, event);
  if (next === null) return { kind: 'illegal', detail: 'not in transition table' };
  if (before.locked) return { kind: 'illegal', detail: 'guard orders.locked=false failed' };
  if (from === 'VOID') {
    if (before.user_id !== null) {
      return { kind: 'illegal', detail: 'guard VOID with empty user_id failed' };
    }
    return { kind: 'R3b', step: next };
  }
  return { kind: 'R3', step: next };
}
