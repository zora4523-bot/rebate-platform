// 生成物，勿手改。来源：specs/state-machines/deletion-request.yaml（字段 status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type DeletionRequestState =
  | 'cooling'
  | 'processing'
  | 'done'
  | 'cancelled';

export const DELETION_REQUEST_STATES: readonly DeletionRequestState[] = ['cooling', 'processing', 'done', 'cancelled'];

export type DeletionRequestEvent =
  | 'PROCESS'
  | 'COMPLETE'
  | 'CANCEL';

export const DELETION_REQUEST_EVENTS: readonly DeletionRequestEvent[] = ['PROCESS', 'COMPLETE', 'CANCEL'];

export interface DeletionRequestTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (DeletionRequestState | null | '*')[];
  readonly event: DeletionRequestEvent | null;
  readonly to: DeletionRequestState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const DELETION_REQUEST_TRANSITIONS: readonly DeletionRequestTransitionRow[] = [
  {
    id: 'D1',
    from: ['cooling'],
    event: 'PROCESS',
    to: 'processing',
    guard: '冷静期已满（now ≥ cooling_until）；重新检查余额 available_fen ≥ 0；该用户所有提现已到终态（未到终态则推迟并告警、不迁移）；同一事务先把 users.status 置为 deleting（BR-ID-27）',
    test_id: 'SM-DEL-D1',
  },
  {
    id: 'D2',
    from: ['processing'],
    event: 'COMPLETE',
    to: 'done',
    guard: 'BR-ID-28 清单处理完毕，users 行保留为墓碑（status=deleted）；processed_at 同次写入；自 requested_at 起 ≤15 个工作日必须到 done（BR-ID-27）',
    test_id: 'SM-DEL-D2',
  },
  {
    id: 'D3',
    from: ['cooling'],
    event: 'CANCEL',
    to: 'cancelled',
    guard: '两种情形，原因由服务层写 cancel_reason：① 用户显式撤回且 now < cooling_until（cancel_reason=user；超过返回 10007，不迁移）；② 冷静期满重新检查余额 available_fen < 0（cancel_reason=negative_balance，ADD-07）',
    test_id: 'SM-DEL-D3',
  },
];

export type DeletionRequestTransitionResult =
  | { ok: true; to: DeletionRequestState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionDeletionRequest(from: DeletionRequestState | null, event: DeletionRequestEvent): DeletionRequestTransitionResult {
  for (const row of DELETION_REQUEST_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as DeletionRequestState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
