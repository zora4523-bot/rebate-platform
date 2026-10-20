// B1-15b test 阶段骨架；实现阶段从 YAML 生成 deletion-request.gen.ts 并切换入口导出。
export type DeletionRequestState = 'cooling' | 'processing' | 'done' | 'cancelled';
export type DeletionRequestEvent = 'PROCESS' | 'COMPLETE' | 'CANCEL';

export interface DeletionRequestTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (DeletionRequestState | null | '*')[];
  readonly event: DeletionRequestEvent | null;
  readonly to: DeletionRequestState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export type DeletionRequestTransitionResult =
  | { ok: true; to: DeletionRequestState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionDeletionRequest(
  from: DeletionRequestState | null,
  event: DeletionRequestEvent,
): DeletionRequestTransitionResult {
  void from;
  void event;
  throw new Error('NotImplemented: transitionDeletionRequest');
}
