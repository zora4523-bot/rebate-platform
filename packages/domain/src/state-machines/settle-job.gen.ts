// 生成物，勿手改。来源：specs/state-machines/settle-job.yaml（字段 status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type SettleJobState =
  | 'running'
  | 'done'
  | 'failed';

export const SETTLE_JOB_STATES: readonly SettleJobState[] = ['running', 'done', 'failed'];

export type SettleJobEvent =
  | 'START'
  | 'COMPLETE'
  | 'FAIL'
  | 'RETRY';

export const SETTLE_JOB_EVENTS: readonly SettleJobEvent[] = ['START', 'COMPLETE', 'FAIL', 'RETRY'];

export interface SettleJobTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (SettleJobState | null | '*')[];
  readonly event: SettleJobEvent | null;
  readonly to: SettleJobState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const SETTLE_JOB_TRANSITIONS: readonly SettleJobTransitionRow[] = [
  {
    id: 'SJ1',
    from: [null],
    event: 'START',
    to: 'running',
    guard: '—（入库首态：任务开始运行时插入该行）',
    test_id: 'SM-SJ-1',
  },
  {
    id: 'SJ2',
    from: ['running'],
    event: 'COMPLETE',
    to: 'done',
    guard: '—（任务全部处理完）',
    test_id: 'SM-SJ-2',
  },
  {
    id: 'SJ3',
    from: ['running'],
    event: 'FAIL',
    to: 'failed',
    guard: '—（任务失败，记原因）',
    test_id: 'SM-SJ-3',
  },
  {
    id: 'SJ4',
    from: ['failed'],
    event: 'RETRY',
    to: 'running',
    guard: '补跑沿用同一 run_at，在同一行重跑（decision 46）',
    test_id: 'SM-SJ-4',
  },
];

export type SettleJobTransitionResult =
  | { ok: true; to: SettleJobState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionSettleJob(from: SettleJobState | null, event: SettleJobEvent): SettleJobTransitionResult {
  for (const row of SETTLE_JOB_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as SettleJobState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
