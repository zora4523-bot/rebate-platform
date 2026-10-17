// 生成物，勿手改。来源：specs/state-machines/order-rebate.yaml（字段 rebate_status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type OrderRebateState =
  | 'UNATTRIBUTED'
  | 'ESTIMATED'
  | 'WAITING'
  | 'CREDITED'
  | 'VOID'
  | 'CLAWED_BACK';

export const ORDER_REBATE_STATES: readonly OrderRebateState[] = ['UNATTRIBUTED', 'ESTIMATED', 'WAITING', 'CREDITED', 'VOID', 'CLAWED_BACK'];

export type OrderRebateEvent =
  | 'IMPORT_UNATTRIBUTED'
  | 'IMPORT_ATTRIBUTED'
  | 'CLAIM_APPROVED'
  | 'ADMIN_REASSIGN'
  | 'SYNC_ATTRIBUTED'
  | 'PLATFORM_RECEIVED_OR_SETTLED'
  | 'SETTLE_BATCH_CREDIT'
  | 'BENEFICIARY_RELEASE'
  | 'PLATFORM_INVALID'
  | 'RIGHTS_FULL'
  | 'PUNISH'
  | 'BLACKLIST_HIT'
  | 'BASE_ZERO'
  | 'PARTIAL_REFUND'
  | 'RIGHTS_PARTIAL'
  | 'COMMISSION_CHANGED'
  | 'REFUND_AFTER_SETTLE'
  | 'INVALID_AFTER_SETTLE'
  | 'COMMISSION_POSITIVE_ZERO'
  | 'BLACKLIST_CONFIRMED'
  | 'ESTIMATE_CHANGED'
  | 'SETTLE_NEGATIVE_DIFF'
  | 'SETTLE_POSITIVE_DIFF_APPROVED'
  | 'HOLD'
  | 'UNHOLD'
  | 'ADMIN_RESTORE';

export const ORDER_REBATE_EVENTS: readonly OrderRebateEvent[] = ['IMPORT_UNATTRIBUTED', 'IMPORT_ATTRIBUTED', 'CLAIM_APPROVED', 'ADMIN_REASSIGN', 'SYNC_ATTRIBUTED', 'PLATFORM_RECEIVED_OR_SETTLED', 'SETTLE_BATCH_CREDIT', 'BENEFICIARY_RELEASE', 'PLATFORM_INVALID', 'RIGHTS_FULL', 'PUNISH', 'BLACKLIST_HIT', 'BASE_ZERO', 'PARTIAL_REFUND', 'RIGHTS_PARTIAL', 'COMMISSION_CHANGED', 'REFUND_AFTER_SETTLE', 'INVALID_AFTER_SETTLE', 'COMMISSION_POSITIVE_ZERO', 'BLACKLIST_CONFIRMED', 'ESTIMATE_CHANGED', 'SETTLE_NEGATIVE_DIFF', 'SETTLE_POSITIVE_DIFF_APPROVED', 'HOLD', 'UNHOLD', 'ADMIN_RESTORE'];

export interface OrderRebateTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (OrderRebateState | null | '*')[];
  readonly event: OrderRebateEvent | null;
  readonly to: OrderRebateState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const ORDER_REBATE_TRANSITIONS: readonly OrderRebateTransitionRow[] = [
  {
    id: 'R1',
    from: [null],
    event: 'IMPORT_UNATTRIBUTED',
    to: 'UNATTRIBUTED',
    guard: '—',
    test_id: 'SM-REB-R1',
  },
  {
    id: 'R2',
    from: [null],
    event: 'IMPORT_ATTRIBUTED',
    to: 'ESTIMATED',
    guard: '—',
    test_id: 'SM-REB-R2',
  },
  {
    id: 'R3',
    from: ['UNATTRIBUTED'],
    event: 'CLAIM_APPROVED',
    to: 'ESTIMATED',
    guard: 'orders.locked=false（未被其他用户认领或改派）；平台已为 RECEIVED / SETTLED 时由调用方再按 R4 进 WAITING',
    test_id: 'SM-REB-R3',
  },
  {
    id: 'R3',
    from: ['UNATTRIBUTED'],
    event: 'ADMIN_REASSIGN',
    to: 'ESTIMATED',
    guard: 'orders.locked=false（未被其他用户认领或改派）；平台已为 RECEIVED / SETTLED 时由调用方再按 R4 进 WAITING',
    test_id: 'SM-REB-R3',
  },
  {
    id: 'R3a',
    from: ['UNATTRIBUTED'],
    event: 'SYNC_ATTRIBUTED',
    to: 'ESTIMATED',
    guard: 'orders.locked=false；平台已为 RECEIVED / SETTLED 时由调用方再按 R4 进 WAITING',
    test_id: 'SM-REB-R3a',
  },
  {
    id: 'R3b',
    from: ['VOID'],
    event: 'ADMIN_REASSIGN',
    to: 'same',
    guard: 'VOID 且 user_id 为空；orders.locked=false',
    test_id: 'SM-REB-R3b',
  },
  {
    id: 'R3b',
    from: ['VOID'],
    event: 'SYNC_ATTRIBUTED',
    to: 'same',
    guard: 'VOID 且 user_id 为空；orders.locked=false',
    test_id: 'SM-REB-R3b',
  },
  {
    id: 'R4',
    from: ['ESTIMATED'],
    event: 'PLATFORM_RECEIVED_OR_SETTLED',
    to: 'WAITING',
    guard: 'received_at 已按 BR-FUND-02 取得（平台返回的收货、完成时间，或 P5、P12 的结算时间）；取不到时不迁移，订单进待处理表',
    test_id: 'SM-REB-R4',
  },
  {
    id: 'R5',
    from: ['WAITING'],
    event: 'SETTLE_BATCH_CREDIT',
    to: 'CREDITED',
    guard: 'BR-FUND-04 ④ 一致性校验通过且 ⑦ 执行校验通过',
    test_id: 'SM-REB-R5',
  },
  {
    id: 'R5a',
    from: ['CREDITED'],
    event: 'BENEFICIARY_RELEASE',
    to: 'same',
    guard: '该受益人的补记项通过 BR-FUND-04 ⑫ 的执行重验（订单为 CREDITED、rights_pending=false、结算记录 seq 未变、归属快照未变、该待补记义务未完成，且本单 BR-FUND-19 ⑤ 等式成立）；BR-FUND-04 ⑦ 的「仍为 WAITING」不适用；在解除后的下一个结算批次（含补充批次）处理',
    test_id: 'SM-REB-R5a',
  },
  {
    id: 'R6',
    from: ['UNATTRIBUTED', 'ESTIMATED', 'WAITING'],
    event: 'PLATFORM_INVALID',
    to: 'VOID',
    guard: '基数归零分支：platform_status ≠ DEPOSIT_PAID，且新 B_est 非 null；B_est 按 BR-CALC-02 由有效联盟佣金换算，结算佣金已到之后预估单独变化不触发（BR-FUND-07）',
    test_id: 'SM-REB-R6',
  },
  {
    id: 'R6',
    from: ['UNATTRIBUTED', 'ESTIMATED', 'WAITING'],
    event: 'RIGHTS_FULL',
    to: 'VOID',
    guard: '基数归零分支：platform_status ≠ DEPOSIT_PAID，且新 B_est 非 null；B_est 按 BR-CALC-02 由有效联盟佣金换算，结算佣金已到之后预估单独变化不触发（BR-FUND-07）',
    test_id: 'SM-REB-R6',
  },
  {
    id: 'R6',
    from: ['UNATTRIBUTED', 'ESTIMATED', 'WAITING'],
    event: 'PUNISH',
    to: 'VOID',
    guard: '基数归零分支：platform_status ≠ DEPOSIT_PAID，且新 B_est 非 null；B_est 按 BR-CALC-02 由有效联盟佣金换算，结算佣金已到之后预估单独变化不触发（BR-FUND-07）',
    test_id: 'SM-REB-R6',
  },
  {
    id: 'R6',
    from: ['UNATTRIBUTED', 'ESTIMATED', 'WAITING'],
    event: 'BLACKLIST_HIT',
    to: 'VOID',
    guard: '基数归零分支：platform_status ≠ DEPOSIT_PAID，且新 B_est 非 null；B_est 按 BR-CALC-02 由有效联盟佣金换算，结算佣金已到之后预估单独变化不触发（BR-FUND-07）',
    test_id: 'SM-REB-R6',
  },
  {
    id: 'R6',
    from: ['UNATTRIBUTED', 'ESTIMATED', 'WAITING'],
    event: 'BASE_ZERO',
    to: 'VOID',
    guard: '基数归零分支：platform_status ≠ DEPOSIT_PAID，且新 B_est 非 null；B_est 按 BR-CALC-02 由有效联盟佣金换算，结算佣金已到之后预估单独变化不触发（BR-FUND-07）',
    test_id: 'SM-REB-R6',
  },
  {
    id: 'R7',
    from: ['ESTIMATED', 'WAITING'],
    event: 'PARTIAL_REFUND',
    to: 'same',
    guard: '新 B>0，或原 B 已为 0，或原 B 为 null（从未收到佣金数值，BR-FUND-07 细则「边界（佣金为空）」；2026-10-06 代理按 规划/11 §7.1 用 Jev 判断，置信度 0.66，规划/12 §9 F-21）',
    test_id: 'SM-REB-R7',
  },
  {
    id: 'R7',
    from: ['ESTIMATED', 'WAITING'],
    event: 'RIGHTS_PARTIAL',
    to: 'same',
    guard: '新 B>0，或原 B 已为 0，或原 B 为 null（从未收到佣金数值，BR-FUND-07 细则「边界（佣金为空）」；2026-10-06 代理按 规划/11 §7.1 用 Jev 判断，置信度 0.66，规划/12 §9 F-21）',
    test_id: 'SM-REB-R7',
  },
  {
    id: 'R7',
    from: ['ESTIMATED', 'WAITING'],
    event: 'COMMISSION_CHANGED',
    to: 'same',
    guard: '新 B>0，或原 B 已为 0，或原 B 为 null（从未收到佣金数值，BR-FUND-07 细则「边界（佣金为空）」；2026-10-06 代理按 规划/11 §7.1 用 Jev 判断，置信度 0.66，规划/12 §9 F-21）',
    test_id: 'SM-REB-R7',
  },
  {
    id: 'R8',
    from: ['CREDITED'],
    event: 'PLATFORM_INVALID',
    to: 'CLAWED_BACK',
    guard: '—',
    test_id: 'SM-REB-R8',
  },
  {
    id: 'R8',
    from: ['CREDITED'],
    event: 'RIGHTS_FULL',
    to: 'CLAWED_BACK',
    guard: '—',
    test_id: 'SM-REB-R8',
  },
  {
    id: 'R8',
    from: ['CREDITED'],
    event: 'PUNISH',
    to: 'CLAWED_BACK',
    guard: '—',
    test_id: 'SM-REB-R8',
  },
  {
    id: 'R8',
    from: ['CREDITED'],
    event: 'REFUND_AFTER_SETTLE',
    to: 'CLAWED_BACK',
    guard: '—',
    test_id: 'SM-REB-R8',
  },
  {
    id: 'R8',
    from: ['CREDITED'],
    event: 'INVALID_AFTER_SETTLE',
    to: 'CLAWED_BACK',
    guard: '—',
    test_id: 'SM-REB-R8',
  },
  {
    id: 'R8',
    from: ['CREDITED'],
    event: 'COMMISSION_POSITIVE_ZERO',
    to: 'CLAWED_BACK',
    guard: '—',
    test_id: 'SM-REB-R8',
  },
  {
    id: 'R8',
    from: ['CREDITED'],
    event: 'BASE_ZERO',
    to: 'CLAWED_BACK',
    guard: '—',
    test_id: 'SM-REB-R8',
  },
  {
    id: 'R8',
    from: ['CREDITED'],
    event: 'BLACKLIST_CONFIRMED',
    to: 'CLAWED_BACK',
    guard: '—',
    test_id: 'SM-REB-R8',
  },
  {
    id: 'R9',
    from: ['CREDITED'],
    event: 'PARTIAL_REFUND',
    to: 'same',
    guard: '新基数大于 0，或新旧基数都为 0 且新的有效联盟佣金大于 0（BR-FUND-05 基数为 0 仍记预留的订单）',
    test_id: 'SM-REB-R9',
  },
  {
    id: 'R9',
    from: ['CREDITED'],
    event: 'RIGHTS_PARTIAL',
    to: 'same',
    guard: '新基数大于 0，或新旧基数都为 0 且新的有效联盟佣金大于 0（BR-FUND-05 基数为 0 仍记预留的订单）',
    test_id: 'SM-REB-R9',
  },
  {
    id: 'R9b',
    from: ['CREDITED'],
    event: 'ESTIMATE_CHANGED',
    to: 'same',
    guard: '—',
    test_id: 'SM-REB-R9b',
  },
  {
    id: 'R10',
    from: ['CREDITED'],
    event: 'SETTLE_NEGATIVE_DIFF',
    to: 'same',
    guard: 'BR-FUND-09；新基数大于 0，或新旧基数都为 0 且新的结算佣金（正数部分）大于 0（BR-FUND-05 基数为 0 仍记预留的订单）',
    test_id: 'SM-REB-R10',
  },
  {
    id: 'R10',
    from: ['CREDITED'],
    event: 'SETTLE_POSITIVE_DIFF_APPROVED',
    to: 'same',
    guard: 'BR-FUND-09；新基数大于 0，或新旧基数都为 0 且新的结算佣金（正数部分）大于 0（BR-FUND-05 基数为 0 仍记预留的订单）',
    test_id: 'SM-REB-R10',
  },
  {
    id: 'R11',
    from: ['ESTIMATED', 'WAITING'],
    event: 'HOLD',
    to: 'same',
    guard: 'BR-FUND-06 的角色；hold=true',
    test_id: 'SM-REB-R11',
  },
  {
    id: 'R11',
    from: ['ESTIMATED', 'WAITING'],
    event: 'UNHOLD',
    to: 'same',
    guard: 'BR-FUND-06 的角色；hold=false',
    test_id: 'SM-REB-R11',
  },
  {
    id: 'R12',
    from: ['VOID'],
    event: 'ADMIN_RESTORE',
    to: 'ESTIMATED',
    guard: '见 BR-FUND-22（差错单经 ADMIN_RESTORE 处理：超管或被勾选该权限的账号 step-up 后处理）；按当前 platform_status 回到 ESTIMATED 或 WAITING、user_id 为空的回到 UNATTRIBUTED，由调用方判断',
    test_id: 'SM-REB-R12',
  },
  {
    id: 'R13',
    from: ['CLAWED_BACK'],
    event: 'ADMIN_RESTORE',
    to: 'CREDITED',
    guard: '见 BR-FUND-22（差错单经 ADMIN_RESTORE 处理：超管或被勾选该权限的账号 step-up 后处理）',
    test_id: 'SM-REB-R13',
  },
  {
    id: 'R14',
    from: ['ESTIMATED', 'WAITING', 'CREDITED'],
    event: 'ADMIN_REASSIGN',
    to: 'same',
    guard: '有权限者 step-up 确认（一人可完成，ADD-05）',
    test_id: 'SM-REB-R14',
  },
];

export type OrderRebateTransitionResult =
  | { ok: true; to: OrderRebateState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionOrderRebate(from: OrderRebateState | null, event: OrderRebateEvent): OrderRebateTransitionResult {
  for (const row of ORDER_REBATE_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as OrderRebateState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
