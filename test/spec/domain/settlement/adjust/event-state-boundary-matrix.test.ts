import { planCommissionAdjustment } from '@couli/domain';
import type {
  AdjustmentBeneficiary,
  AdjustmentBeneficiaryResult,
  AdjustmentPlan,
} from '@couli/domain';
import { subFen } from '@couli/money';
import { expect, it } from 'vitest';
import { beneficiary, freezeInput, input } from './fixtures.ts';

// 第 11 节矩阵：“新旧差额”在这里明确为 ΔN；同时分别覆盖 ΔB=0 与 ΔB≠0。
// BR-CALC-09、BR-FUND-08/09：旧 B=500，预留 5000bp，唯一推广份额 5000bp，重拆为 250。
// 无义务：净额 250；有首次入账义务：净额 0、待补记 250。两种输入平台净额均为 N_old−250。
// BR-FUND-04⑫：首次义务整笔没收追加 forfeited；正常正差获批后关闭（API 用 done）；R8 作废。
// 每行四组数均为手算期望，未调用被测计算器或 money 的分账函数生成 oracle。
type Amounts = readonly [
  entitlement: bigint,
  delta: bigint,
  netAfter: bigint,
  pendingAfter: bigint,
  forfeit: bigint,
  action: AdjustmentBeneficiaryResult['obligation_action'],
  platformAfter: bigint,
  platformDelta: bigint,
  receivableDelta: bigint,
];

interface MatrixRow {
  readonly cell: string;
  readonly event: 'settlement' | 'clawback';
  readonly oldN: bigint;
  readonly oldPlatform: bigint;
  readonly newN: bigint;
  readonly newB: bigint;
  readonly reserve: bigint;
  readonly route: AdjustmentPlan['route'];
  readonly transition: AdjustmentPlan['transition'];
  readonly normalWithout: Amounts;
  readonly normalWith: Amounts;
  readonly restrictedWithout: Amounts;
  readonly restrictedWith: Amounts;
  readonly forfeitureRoute?: AdjustmentPlan['route'];
  readonly forfeitureTransition?: AdjustmentPlan['transition'];
}

const matrix: readonly MatrixRow[] = [
  // BR-FUND-09③：两值相等无动作，当前状态不能把 settlement 变为义务履约。
  {
    cell: 'ΔN=0/ΔB=0',
    event: 'settlement',
    oldN: 1000n,
    oldPlatform: 750n,
    newN: 1000n,
    newB: 500n,
    reserve: 500n,
    route: 'none',
    transition: null,
    normalWithout: [250n, 0n, 250n, 0n, 0n, null, 750n, 0n, 0n],
    normalWith: [250n, 0n, 0n, 250n, 0n, 'keep', 750n, 0n, 0n],
    restrictedWithout: [250n, 0n, 250n, 0n, 0n, null, 750n, 0n, 0n],
    restrictedWith: [0n, 0n, 0n, 250n, 0n, 'keep', 750n, 0n, 0n],
  },
  // BR-FUND-09：floor(1001×50%)=500，受益人不变；预留 501，平台 +1 进审批。
  {
    cell: 'ΔN>0/ΔB=0',
    event: 'settlement',
    oldN: 1000n,
    oldPlatform: 750n,
    newN: 1001n,
    newB: 500n,
    reserve: 501n,
    route: 'approval',
    transition: 'R10',
    normalWithout: [250n, 0n, 250n, 0n, 0n, null, 751n, 1n, 1n],
    normalWith: [250n, 0n, 0n, 250n, 0n, 'keep', 751n, 1n, 1n],
    restrictedWithout: [250n, 0n, 250n, 0n, 0n, null, 751n, 1n, 1n],
    restrictedWith: [0n, 0n, 0n, 250n, 0n, 'keep', 751n, 1n, 1n],
  },
  // BR-FUND-09：反向 1001→1000 仍 B=500，只冲平台 1，不能没收或补记义务。
  {
    cell: 'ΔN<0/ΔB=0',
    event: 'settlement',
    oldN: 1001n,
    oldPlatform: 751n,
    newN: 1000n,
    newB: 500n,
    reserve: 500n,
    route: 'immediate',
    transition: 'R10',
    normalWithout: [250n, 0n, 250n, 0n, 0n, null, 750n, -1n, -1n],
    normalWith: [250n, 0n, 0n, 250n, 0n, 'keep', 750n, -1n, -1n],
    restrictedWithout: [250n, 0n, 250n, 0n, 0n, null, 750n, -1n, -1n],
    restrictedWith: [0n, 0n, 0n, 250n, 0n, 'keep', 750n, -1n, -1n],
  },
  // BR-CALC-09、BR-FUND-09/04⑫：B=600，份额 300。正常补 50/300；受限没收 50/300。
  // 有义务时待补记 250→0，应收净影响 = 200−(0−250)=450。
  {
    cell: 'ΔN>0/ΔB>0',
    event: 'settlement',
    oldN: 1000n,
    oldPlatform: 750n,
    newN: 1200n,
    newB: 600n,
    reserve: 600n,
    route: 'approval',
    transition: 'R10',
    normalWithout: [300n, 50n, 300n, 0n, 0n, null, 900n, 150n, 200n],
    normalWith: [300n, 300n, 300n, 0n, 0n, 'done', 900n, 150n, 450n],
    restrictedWithout: [250n, 0n, 250n, 0n, 50n, null, 950n, 200n, 200n],
    restrictedWith: [0n, 0n, 0n, 0n, 300n, 'forfeited', 1200n, 450n, 450n],
  },
  // BR-FUND-09①：B=400，份额 200。无义务扣 50；正常有义务保留 200，不进正差候选。
  // 受限义务没收 200：平台 800−750=+50，应收 -200−(0−250)=+50，仍即时负差一路。
  {
    cell: 'ΔN<0/ΔB<0/非终态',
    event: 'settlement',
    oldN: 1000n,
    oldPlatform: 750n,
    newN: 800n,
    newB: 400n,
    reserve: 400n,
    route: 'immediate',
    transition: 'R10',
    normalWithout: [200n, -50n, 200n, 0n, 0n, null, 600n, -150n, -200n],
    normalWith: [200n, 0n, 0n, 200n, 0n, 'keep', 600n, -150n, -150n],
    restrictedWithout: [200n, -50n, 200n, 0n, 0n, null, 600n, -150n, -200n],
    restrictedWith: [0n, 0n, 0n, 0n, 200n, 'forfeited', 800n, 50n, 50n],
  },
  // BR-FUND-08/09：结算 N 归零也必须 R8；待补记 250 消失，所以有义务时只冲平台 750。
  {
    cell: 'ΔN<0/ΔB<0/N归零',
    event: 'settlement',
    oldN: 1000n,
    oldPlatform: 750n,
    newN: 0n,
    newB: 0n,
    reserve: 0n,
    route: 'immediate',
    transition: 'R8',
    normalWithout: [0n, -250n, 0n, 0n, 0n, null, 0n, -750n, -1000n],
    normalWith: [0n, 0n, 0n, 0n, 0n, 'voided', 0n, -750n, -750n],
    restrictedWithout: [0n, -250n, 0n, 0n, 0n, null, 0n, -750n, -1000n],
    restrictedWith: [0n, 0n, 0n, 0n, 0n, 'voided', 0n, -750n, -750n],
  },
  // BR-FUND-08、BR-CALC-09、BR-FUND-04⑫（任务 §11）：扣回零差仍按当前状态处置义务。
  // 受限且有义务：250 全没收，平台 750→1000，应收 0−(0−250)=250，须即时 R9。
  // 其他格无金额动作可为 none，但所有扣回格均作废未批准正差候选。
  {
    cell: 'ΔN=0/ΔB=0',
    event: 'clawback',
    oldN: 1000n,
    oldPlatform: 750n,
    newN: 1000n,
    newB: 500n,
    reserve: 500n,
    route: 'none',
    transition: null,
    forfeitureRoute: 'immediate',
    forfeitureTransition: 'R9',
    normalWithout: [250n, 0n, 250n, 0n, 0n, null, 750n, 0n, 0n],
    normalWith: [250n, 0n, 0n, 250n, 0n, 'keep', 750n, 0n, 0n],
    restrictedWithout: [250n, 0n, 250n, 0n, 0n, null, 750n, 0n, 0n],
    restrictedWith: [0n, 0n, 0n, 0n, 250n, 'forfeited', 1000n, 250n, 250n],
  },
  // BR-FUND-08：扣回不走结算补差审批；平台差额允许任意符号。
  // 即使 N 上升 1、B 不变，仍即时处置扣回事件；有受限义务时平台 +251，应收 +251。
  {
    cell: 'ΔN>0/ΔB=0',
    event: 'clawback',
    oldN: 1000n,
    oldPlatform: 750n,
    newN: 1001n,
    newB: 500n,
    reserve: 501n,
    route: 'immediate',
    transition: 'R9',
    normalWithout: [250n, 0n, 250n, 0n, 0n, null, 751n, 1n, 1n],
    normalWith: [250n, 0n, 0n, 250n, 0n, 'keep', 751n, 1n, 1n],
    restrictedWithout: [250n, 0n, 250n, 0n, 0n, null, 751n, 1n, 1n],
    restrictedWith: [0n, 0n, 0n, 0n, 250n, 'forfeited', 1001n, 251n, 251n],
  },
  // BR-FUND-08/04⑫：B 不变，正常义务保留；受限义务没收后平台 1000−751=249。
  {
    cell: 'ΔN<0/ΔB=0',
    event: 'clawback',
    oldN: 1001n,
    oldPlatform: 751n,
    newN: 1000n,
    newB: 500n,
    reserve: 500n,
    route: 'immediate',
    transition: 'R9',
    normalWithout: [250n, 0n, 250n, 0n, 0n, null, 750n, -1n, -1n],
    normalWith: [250n, 0n, 0n, 250n, 0n, 'keep', 750n, -1n, -1n],
    restrictedWithout: [250n, 0n, 250n, 0n, 0n, null, 750n, -1n, -1n],
    restrictedWith: [0n, 0n, 0n, 0n, 250n, 'forfeited', 1000n, 249n, 249n],
  },
  // BR-FUND-08：扣回额≤0 不给用户记正向 CLAWBACK；正常多出的 50 留作待补记。
  // BR-FUND-04⑫：已有义务复用，无义务才 open；受限份额归平台，不能套 settlement 正差一路。
  {
    cell: 'ΔN>0/ΔB>0',
    event: 'clawback',
    oldN: 1000n,
    oldPlatform: 750n,
    newN: 1200n,
    newB: 600n,
    reserve: 600n,
    route: 'immediate',
    transition: 'R9',
    normalWithout: [300n, 0n, 250n, 50n, 0n, 'open', 900n, 150n, 150n],
    normalWith: [300n, 0n, 0n, 300n, 0n, 'keep', 900n, 150n, 150n],
    restrictedWithout: [250n, 0n, 250n, 0n, 50n, null, 950n, 200n, 200n],
    restrictedWith: [0n, 0n, 0n, 0n, 300n, 'forfeited', 1200n, 450n, 450n],
  },
  // BR-CALC-09、BR-FUND-08/04⑫：同样重拆 200，扣回事件迁移 R9，平台正差不改变路径。
  {
    cell: 'ΔN<0/ΔB<0/非终态',
    event: 'clawback',
    oldN: 1000n,
    oldPlatform: 750n,
    newN: 800n,
    newB: 400n,
    reserve: 400n,
    route: 'immediate',
    transition: 'R9',
    normalWithout: [200n, -50n, 200n, 0n, 0n, null, 600n, -150n, -200n],
    normalWith: [200n, 0n, 0n, 200n, 0n, 'keep', 600n, -150n, -150n],
    restrictedWithout: [200n, -50n, 200n, 0n, 0n, null, 600n, -150n, -200n],
    restrictedWith: [0n, 0n, 0n, 0n, 200n, 'forfeited', 800n, 50n, 50n],
  },
  // BR-FUND-08：终态 R8 优先；受限身份也作废未完成义务，不追加首次份额没收事件。
  {
    cell: 'ΔN<0/ΔB<0/N归零',
    event: 'clawback',
    oldN: 1000n,
    oldPlatform: 750n,
    newN: 0n,
    newB: 0n,
    reserve: 0n,
    route: 'immediate',
    transition: 'R8',
    normalWithout: [0n, -250n, 0n, 0n, 0n, null, 0n, -750n, -1000n],
    normalWith: [0n, 0n, 0n, 0n, 0n, 'voided', 0n, -750n, -750n],
    restrictedWithout: [0n, -250n, 0n, 0n, 0n, null, 0n, -750n, -1000n],
    restrictedWith: [0n, 0n, 0n, 0n, 0n, 'voided', 0n, -750n, -750n],
  },
];

const states = [
  { label: '正常', risk_state: 'normal', deletion_status: null, is_minor: false, reason: null },
  { label: '封禁', risk_state: 'banned', deletion_status: null, is_minor: false, reason: 'banned' },
  {
    label: '注销中',
    risk_state: 'normal',
    deletion_status: 'processing',
    is_minor: false,
    reason: 'deleted',
  },
  {
    label: '已注销',
    risk_state: 'normal',
    deletion_status: 'done',
    is_minor: false,
    reason: 'deleted',
  },
  {
    label: '未成年推广',
    risk_state: 'normal',
    deletion_status: null,
    is_minor: true,
    reason: 'minor',
  },
] as const;

const cells = matrix.flatMap((row) =>
  states.flatMap((state) =>
    [false, true].map((hasObligation) => ({
      row,
      state,
      hasObligation,
      label: `${row.event}/${row.cell}/${state.label}/${hasObligation ? '有首次义务' : '无义务'}`,
      expected:
        state.reason === null
          ? hasObligation
            ? row.normalWith
            : row.normalWithout
          : hasObligation
            ? row.restrictedWith
            : row.restrictedWithout,
    })),
  ),
);

it.each(cells)('[AC-B2-04g#43] 边界矩阵 $label', ({ row, state, hasObligation, expected }) => {
  const [
    entitlement,
    delta,
    netAfter,
    pendingAfter,
    forfeit,
    action,
    platformAfter,
    platformDelta,
    receivableDelta,
  ] = expected;
  const route = action === 'forfeited' ? (row.forfeitureRoute ?? row.route) : row.route;
  const transition =
    action === 'forfeited' ? (row.forfeitureTransition ?? row.transition) : row.transition;
  const person: AdjustmentBeneficiary = beneficiary({
    role: 'share',
    ratio_bp: 5000n,
    risk_state: state.risk_state,
    deletion_status: state.deletion_status,
    is_minor: state.is_minor,
    net_fen: hasObligation ? 0n : 250n,
    obligation: hasObligation
      ? { beneficiary_credit_id: 'matrix-first', kind: 'first_credit' }
      : null,
  });
  const plan = planCommissionAdjustment(
    freezeInput(
      input({
        event: row.event,
        reserve_bp: 5000n,
        booked_base_fen: 500n,
        booked_n_fen: row.oldN,
        n_new_fen: row.newN,
        platform_net_fen: row.oldPlatform,
        beneficiaries: [person],
      }),
    ),
  );

  expect(plan.beneficiaries).toEqual([
    {
      user_id: 'u1',
      role: 'share',
      entitlement_fen: entitlement,
      delta_fen: delta,
      net_after_fen: netAfter,
      // BR-CALC-09、BR-FUND-08/09：注销者负差是坏账，仍计其净额；零差不写任何用户凭证。
      posting:
        delta === 0n
          ? null
          : state.reason === 'deleted' && delta < 0n
            ? 'bad_debt'
            : 'user_available',
      forfeit_fen: forfeit,
      forfeit_reason: forfeit > 0n ? state.reason : null,
      pending_before_fen: hasObligation ? 250n : 0n,
      pending_after_fen: pendingAfter,
      obligation_action: action,
      beneficiary_credit_id: hasObligation ? 'matrix-first' : null,
      append_forfeited_event: action === 'forfeited',
    },
  ]);
  expect(plan).toMatchObject({
    route,
    transition,
    rebate_status: transition === 'R8' ? 'CLAWED_BACK' : 'CREDITED',
    ledger_type: transition === null ? null : transition === 'R10' ? 'SETTLE_ADJUST' : 'CLAWBACK',
    reserve_fen: row.reserve,
    booked_after: { booked_base_fen: row.newB, booked_n_fen: row.newN },
    platform_after_fen: platformAfter,
    platform_delta_fen: platformDelta,
    union_receivable_delta_fen: receivableDelta,
    void_pending_candidates: row.event === 'clawback' || transition === 'R8',
  });
  // API 的 platform_delta 为“新−旧”，与 BR-FUND-08 的“扣回差额”相反；逐格校验借贷方向。
  expect(plan.platform_posting).toEqual(
    platformDelta === 0n
      ? null
      : {
          amount_fen: platformDelta > 0n ? platformDelta : subFen(0n, platformDelta),
          debit: platformDelta > 0n ? 'UNION_RECEIVABLE' : 'COMMISSION_REVENUE',
          credit: platformDelta > 0n ? 'COMMISSION_REVENUE' : 'UNION_RECEIVABLE',
        },
  );
});
