// 生成物，勿手改。来源：specs/state-machines/settle-batch.yaml（字段 status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type SettleBatchState =
  | 'DRAFT'
  | 'CONFIRMED'
  | 'EXECUTING'
  | 'PARTIAL'
  | 'DONE'
  | 'CANCELLED';

export const SETTLE_BATCH_STATES: readonly SettleBatchState[] = ['DRAFT', 'CONFIRMED', 'EXECUTING', 'PARTIAL', 'DONE', 'CANCELLED'];

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

export const SETTLE_BATCH_EVENTS: readonly SettleBatchEvent[] = ['GENERATE', 'CONFIRM', 'CANCEL_SCHEDULE', 'REJECT', 'START', 'COMPLETE', 'SWITCH_OFF', 'RESUME', 'TAKE_OVER', 'MANUAL_START'];

export interface SettleBatchTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (SettleBatchState | null | '*')[];
  readonly event: SettleBatchEvent | null;
  readonly to: SettleBatchState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const SETTLE_BATCH_TRANSITIONS: readonly SettleBatchTransitionRow[] = [
  {
    id: 'SB1',
    from: [null],
    event: 'GENERATE',
    to: 'DRAFT',
    guard: '该平台 credit.enabled 为 on，候选非空',
    test_id: 'SM-SB-1',
  },
  {
    id: 'SB2',
    from: ['DRAFT'],
    event: 'CONFIRM',
    to: 'CONFIRMED',
    guard: '有权限者 step-up；定时须晚于确认时刻，且不落在资产快照的名义时段内（时段取值见 BR-FUND-18）',
    test_id: 'SM-SB-2',
  },
  {
    id: 'SB3',
    from: ['CONFIRMED'],
    event: 'CANCEL_SCHEDULE',
    to: 'DRAFT',
    guard: '定时结算且尚未开始执行',
    test_id: 'SM-SB-3',
  },
  {
    id: 'SB4',
    from: ['DRAFT'],
    event: 'REJECT',
    to: 'CANCELLED',
    guard: 'step-up，必填原因',
    test_id: 'SM-SB-4',
  },
  {
    id: 'SB5',
    from: ['CONFIRMED'],
    event: 'START',
    to: 'EXECUTING',
    guard: '已到执行时刻；当日资产快照已完成或已超时（BR-FUND-18）；settle.auto.enabled 与该平台 credit.enabled 都为 on；该批次没有「因开关为 off 停住」的标记（到执行时刻因开关为 off 未开始时写入，先于快照是否完成的判断，快照未完成时也写；持久化由契约线定；上线前没有存量批次）',
    test_id: 'SM-SB-5',
  },
  {
    id: 'SB6',
    from: ['EXECUTING'],
    event: 'COMPLETE',
    to: 'DONE',
    guard: '—',
    test_id: 'SM-SB-6',
  },
  {
    id: 'SB7',
    from: ['EXECUTING'],
    event: 'SWITCH_OFF',
    to: 'PARTIAL',
    guard: '—',
    test_id: 'SM-SB-7',
  },
  {
    id: 'SB8',
    from: ['PARTIAL'],
    event: 'RESUME',
    to: 'EXECUTING',
    guard: 'step-up；两个开关都为 on（settle.auto.enabled 与该平台 credit.enabled）；当日资产快照已完成或已超时（BR-FUND-18；表下：SB8 因开关为 off 或快照未完成被拒）',
    test_id: 'SM-SB-8',
  },
  {
    id: 'SB9',
    from: ['EXECUTING'],
    event: 'TAKE_OVER',
    to: 'EXECUTING',
    guard: '批次仍为 EXECUTING 且没有存活的执行者；当日资产快照已完成或已超时（BR-FUND-18；执行中跨日暂停后续跑同样要过快照守卫）',
    test_id: 'SM-SB-9',
  },
];

export type SettleBatchTransitionResult =
  | { ok: true; to: SettleBatchState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionSettleBatch(from: SettleBatchState | null, event: SettleBatchEvent): SettleBatchTransitionResult {
  for (const row of SETTLE_BATCH_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as SettleBatchState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
