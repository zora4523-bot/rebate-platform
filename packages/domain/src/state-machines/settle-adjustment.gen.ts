// 生成物，勿手改。来源：specs/state-machines/settle-adjustment.yaml（字段 status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type SettleAdjustmentState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'voided_stale_seq'
  | 'voided_by_clawback';

export const SETTLE_ADJUSTMENT_STATES: readonly SettleAdjustmentState[] = ['pending', 'approved', 'rejected', 'voided_stale_seq', 'voided_by_clawback'];

export type SettleAdjustmentEvent =
  | 'CREATE'
  | 'APPROVE'
  | 'REJECT'
  | 'VOID_STALE_SEQ'
  | 'VOID_BY_CLAWBACK';

export const SETTLE_ADJUSTMENT_EVENTS: readonly SettleAdjustmentEvent[] = ['CREATE', 'APPROVE', 'REJECT', 'VOID_STALE_SEQ', 'VOID_BY_CLAWBACK'];

export interface SettleAdjustmentTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (SettleAdjustmentState | null | '*')[];
  readonly event: SettleAdjustmentEvent | null;
  readonly to: SettleAdjustmentState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const SETTLE_ADJUSTMENT_TRANSITIONS: readonly SettleAdjustmentTransitionRow[] = [
  {
    id: 'SA1',
    from: [null],
    event: 'CREATE',
    to: 'pending',
    guard: 'rebate_status=CREDITED 的子订单整单正差（B_settle > booked_base_fen，或两者相等而结算佣金的正数部分 > booked_n_fen）；R1 随月结账单生成任务运行或 finance 手动触发，候选行记录生成时的 seq；settle.adjust.void_on_clawback.enabled=on 时，同一条结算记录（seq）只在其写入时刻晚于该子订单最近一次扣回（CLAWBACK）时才生成',
    test_id: 'AC-B2-04d#17',
  },
  {
    id: 'SA2',
    from: ['pending'],
    event: 'APPROVE',
    to: 'approved',
    guard: '超管或被勾选补差权限的账号 step-up 批准（一人可完成，写审计）；候选行 seq 等于该订单当前 seq；写凭证时按 orders.settle_commission_fen 当前值换算的 B_settle 与当前净额重算，diff=0 不写凭证',
    test_id: 'AC-B2-04d#17',
  },
  {
    id: 'SA3',
    from: ['pending'],
    event: 'REJECT',
    to: 'rejected',
    guard: '驳回：不记账、不写凭证，保留候选与驳回理由（BR-CALC-23）',
    test_id: 'AC-B2-04d#17',
  },
  {
    id: 'SA4',
    from: ['pending'],
    event: 'VOID_STALE_SEQ',
    to: 'voided_stale_seq',
    guard: '候选行 seq ≠ 该订单当前 seq（过期）：该行作废，不记账、不写凭证',
    test_id: 'AC-B2-04d#17',
  },
  {
    id: 'SA5',
    from: ['pending'],
    event: 'VOID_BY_CLAWBACK',
    to: 'voided_by_clawback',
    guard: '该子订单发生扣回（CLAWBACK）且 settle.adjust.void_on_clawback.enabled=on：扣回的同一事务内作废该单全部未批准的正差候选（作废原因「因扣回作废」，批准接口返回已作废）；off 时候选照常生成、由批准人把关',
    test_id: 'AC-B2-04d#17',
  },
];

export type SettleAdjustmentTransitionResult =
  | { ok: true; to: SettleAdjustmentState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionSettleAdjustment(from: SettleAdjustmentState | null, event: SettleAdjustmentEvent): SettleAdjustmentTransitionResult {
  for (const row of SETTLE_ADJUSTMENT_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as SettleAdjustmentState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
