// B2-04d test 阶段骨架；实现阶段由 YAML 生成器替换。
export type SettleAdjustmentState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'voided_stale_seq'
  | 'voided_by_clawback';
export type SettleAdjustmentEvent =
  | 'CREATE'
  | 'APPROVE'
  | 'REJECT'
  | 'VOID_STALE_SEQ'
  | 'VOID_BY_CLAWBACK';

export type SettleAdjustmentTransitionResult =
  | { ok: true; to: SettleAdjustmentState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionSettleAdjustment(
  from: SettleAdjustmentState | null,
  event: SettleAdjustmentEvent,
): SettleAdjustmentTransitionResult {
  void from;
  void event;
  throw new Error('NotImplemented: transitionSettleAdjustment');
}
