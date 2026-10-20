// B2-04d test 阶段骨架；实现阶段由 YAML 生成器替换。
export type SettleBatchState =
  | 'DRAFT'
  | 'CONFIRMED'
  | 'EXECUTING'
  | 'PARTIAL'
  | 'DONE'
  | 'CANCELLED';

export type SettleBatchEvent =
  | 'GENERATE'
  | 'CONFIRM'
  | 'CANCEL_SCHEDULE'
  | 'REJECT'
  | 'START'
  | 'COMPLETE'
  | 'SWITCH_OFF'
  | 'RESUME'
  | 'TAKE_OVER'
  | 'MANUAL_START';

export type SettleBatchTransitionResult =
  | { ok: true; to: SettleBatchState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionSettleBatch(
  from: SettleBatchState | null,
  event: SettleBatchEvent,
): SettleBatchTransitionResult {
  void from;
  void event;
  throw new Error('NotImplemented: transitionSettleBatch');
}
