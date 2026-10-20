// 生成物，勿手改。来源：specs/state-machines/beneficiary-credit.yaml（字段 status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type BeneficiaryCreditState =
  | 'open'
  | 'done'
  | 'forfeited'
  | 'voided';

export const BENEFICIARY_CREDIT_STATES: readonly BeneficiaryCreditState[] = ['open', 'done', 'forfeited', 'voided'];

export type BeneficiaryCreditEvent =
  | 'OPEN'
  | 'COMPLETE'
  | 'FORFEIT'
  | 'VOID';

export const BENEFICIARY_CREDIT_EVENTS: readonly BeneficiaryCreditEvent[] = ['OPEN', 'COMPLETE', 'FORFEIT', 'VOID'];

export interface BeneficiaryCreditTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (BeneficiaryCreditState | null | '*')[];
  readonly event: BeneficiaryCreditEvent | null;
  readonly to: BeneficiaryCreditState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const BENEFICIARY_CREDIT_TRANSITIONS: readonly BeneficiaryCreditTransitionRow[] = [
  {
    id: 'BC1',
    from: [null],
    event: 'OPEN',
    to: 'open',
    guard: 'CREDITED 子订单上受益人出现待补记额（入账时暂缓 R5 开首次入账义务；改派重记 R14 开改派入账义务，2026-10-18 起不开放；正差被延后或 R13 恢复时受益人冻结或申诉中开延后差额义务）；同一 (子订单, 受益人, 角色) 同时最多一个未完成义务，已有未完成义务时并入它、不另开；在产生它的事务内登记开立事件与归属快照，分配新的 beneficiary_credit_id',
    test_id: 'AC-B2-04d#11',
  },
  {
    id: 'BC2',
    from: ['open'],
    event: 'COMPLETE',
    to: 'done',
    guard: '补记项执行：锁内重验订单仍为 CREDITED、rights_pending=false、结算记录 seq 与生成补记项时一致、归属快照未变、义务仍未完成且本单 BR-FUND-19 ⑤ 等式成立；受益人状态正常（含注销冷静期）时按剩余未履约金额入账，凭证与义务完成同一事务提交，金额为 0 不写凭证、义务同样完成；或迁移 R9、R10（含正差候选获批）等事务把剩余未履约金额整笔补给了受益人，同一事务关闭并关联实际履约的凭证',
    test_id: 'AC-B2-04d#11',
  },
  {
    id: 'BC3',
    from: ['open'],
    event: 'FORFEIT',
    to: 'forfeited',
    guard: '补记项执行时受益人已封禁、已进入注销处理或已注销、已识别未成年人的推广份额：没收剩余未履约金额（带 forfeit_reason，金额为 0 不写凭证）；或迁移 R9、R10（含正差候选获批）等事务把剩余未履约金额整笔归了平台，同一事务关闭并关联实际履约的凭证；首次入账、改派入账义务没收时追加 forfeited 事件，延后差额义务不追加',
    test_id: 'AC-B2-04d#11',
  },
  {
    id: 'BC4',
    from: ['open'],
    event: 'VOID',
    to: 'voided',
    guard: '订单转 CLAWED_BACK（迁移 R8）或改派（迁移 R14）时，同一事务作废该单未完成的义务',
    test_id: 'AC-B2-04d#11',
  },
];

export type BeneficiaryCreditTransitionResult =
  | { ok: true; to: BeneficiaryCreditState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionBeneficiaryCredit(from: BeneficiaryCreditState | null, event: BeneficiaryCreditEvent): BeneficiaryCreditTransitionResult {
  for (const row of BENEFICIARY_CREDIT_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as BeneficiaryCreditState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
