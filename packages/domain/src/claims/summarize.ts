// CT-04e 先红骨架；生成物尚不存在，暂用与 ClaimItemState 等价的字面量类型。
export function summarizeClaimDecisions(
  decisions: readonly ('approved' | 'rejected' | 'cancelled' | null)[],
): 'RESOLVE_APPROVED' | 'RESOLVE_REJECTED' | 'RESOLVE_CANCELLED' | null {
  void decisions;
  throw new Error('NotImplemented: summarizeClaimDecisions');
}

export function evidenceEvent(
  levels: readonly ('strong' | 'weak' | 'none')[],
): 'EVIDENCE_ALL_STRONG' | 'EVIDENCE_NOT_ALL_STRONG' {
  void levels;
  throw new Error('NotImplemented: evidenceEvent');
}
