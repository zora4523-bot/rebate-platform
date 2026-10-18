// 找回汇总（规划/08 BR-ATTR-18；规划/12 §3.3；任务 CT-04e 口径 5）：由子项算出 claim 状态机的事件名，
// 调用方把返回值直接交给 transitionClaim()。纯函数，只依赖生成物的类型。
import type { ClaimEvent } from '../state-machines/claim.gen.ts';
import type { ClaimItemState } from '../state-machines/claim-item.gen.ts';

export type ClaimResolveEvent = Extract<
  ClaimEvent,
  'RESOLVE_APPROVED' | 'RESOLVE_REJECTED' | 'RESOLVE_CANCELLED'
>;
export type ClaimEvidenceEvent = Extract<
  ClaimEvent,
  'EVIDENCE_ALL_STRONG' | 'EVIDENCE_NOT_ALL_STRONG'
>;
export type ClaimEvidenceLevel = 'strong' | 'weak' | 'none';

/**
 * 全部子项已决后汇总：至少 1 个 approved → RESOLVE_APPROVED；否则至少 1 个 rejected → RESOLVE_REJECTED；
 * 否则（全 cancelled）→ RESOLVE_CANCELLED。还有未决子项（null）时返回 null，claim 保持当前状态。
 * claim 至少有一个子项，空数组抛 RangeError。
 */
export function summarizeClaimDecisions(
  decisions: readonly (ClaimItemState | null)[],
): ClaimResolveEvent | null {
  if (decisions.length === 0) {
    throw new RangeError('summarizeClaimDecisions: claim 至少有一个子项');
  }
  if (decisions.includes(null)) return null;
  if (decisions.includes('approved')) return 'RESOLVE_APPROVED';
  if (decisions.includes('rejected')) return 'RESOLVE_REJECTED';
  return 'RESOLVE_CANCELLED';
}

/**
 * 证据算完后的事件：按子项中最弱的证据确定，全部 strong → EVIDENCE_ALL_STRONG，否则 EVIDENCE_NOT_ALL_STRONG。
 * claim 至少有一个子项，空数组抛 RangeError。
 */
export function evidenceEvent(levels: readonly ClaimEvidenceLevel[]): ClaimEvidenceEvent {
  if (levels.length === 0) {
    throw new RangeError('evidenceEvent: claim 至少有一个子项');
  }
  return levels.every((level) => level === 'strong')
    ? 'EVIDENCE_ALL_STRONG'
    : 'EVIDENCE_NOT_ALL_STRONG';
}
