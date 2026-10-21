// 生成物，勿手改。来源：specs/state-machines/export-task.yaml（字段 status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type ExportTaskState =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'expired'
  | 'cancelled';

export const EXPORT_TASK_STATES: readonly ExportTaskState[] = ['pending', 'running', 'done', 'failed', 'expired', 'cancelled'];

export type ExportTaskEvent =
  | 'START'
  | 'COMPLETE'
  | 'FAIL'
  | 'EXPIRE'
  | 'CANCEL'
  | 'RETRY';

export const EXPORT_TASK_EVENTS: readonly ExportTaskEvent[] = ['START', 'COMPLETE', 'FAIL', 'EXPIRE', 'CANCEL', 'RETRY'];

export interface ExportTaskTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (ExportTaskState | null | '*')[];
  readonly event: ExportTaskEvent | null;
  readonly to: ExportTaskState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const EXPORT_TASK_TRANSITIONS: readonly ExportTaskTransitionRow[] = [
  {
    id: 'E1',
    from: ['pending'],
    event: 'START',
    to: 'running',
    guard: '后台任务领取排队中的任务开始生成；同一创建人同时生成中的任务不超过 admin.export.max_running_per_admin，其余留在 pending 等名额空出',
    test_id: 'SM-EXP-E1',
  },
  {
    id: 'E2',
    from: ['running'],
    event: 'COMPLETE',
    to: 'done',
    guard: '一个 CSV 文件已写入私有对象存储桶（行数不超过 admin.export.max_rows，可为 0 行），写 row_count 与 expires_at（生成后 24 小时，BR-ID-30 ⑨）；未脱敏任务另写 export_unmasked 审计的行数',
    test_id: 'SM-EXP-E2',
  },
  {
    id: 'E3',
    from: ['running'],
    event: 'FAIL',
    to: 'failed',
    guard: '生成失败（含行数超过 admin.export.max_rows），写 failure_reason',
    test_id: 'SM-EXP-E3',
  },
  {
    id: 'E4',
    from: ['done'],
    event: 'EXPIRE',
    to: 'expired',
    guard: '到 expires_at（文件生成后 24 小时，对象存储生命周期规则删除文件，BR-ID-30 ⑨）；之后不可下载、不可重试',
    test_id: 'SM-EXP-E4',
  },
  {
    id: 'E5',
    from: ['pending', 'running'],
    event: 'CANCEL',
    to: 'cancelled',
    guard: '创建人后台账号被停用时取消其未完成的任务，并写审计记录；没有取消接口',
    test_id: 'SM-EXP-E5',
  },
  {
    id: 'E6',
    from: ['failed'],
    event: 'RETRY',
    to: 'pending',
    guard: '创建人经 POST /admin/v1/exports/{id}/retry 重试；只有 failed 可重试，重新排队等待生成',
    test_id: 'SM-EXP-E6',
  },
];

export type ExportTaskTransitionResult =
  | { ok: true; to: ExportTaskState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionExportTask(from: ExportTaskState | null, event: ExportTaskEvent): ExportTaskTransitionResult {
  for (const row of EXPORT_TASK_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as ExportTaskState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
