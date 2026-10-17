// 生成物，勿手改。来源：specs/state-machines/commission-rule-version.yaml（字段 status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type CommissionRuleVersionState =
  | 'draft'
  | 'published'
  | 'revoked';

export const COMMISSION_RULE_VERSION_STATES: readonly CommissionRuleVersionState[] = ['draft', 'published', 'revoked'];

export type CommissionRuleVersionEvent =
  | 'DRAFT_CREATED'
  | 'PUBLISH'
  | 'REVOKE';

export const COMMISSION_RULE_VERSION_EVENTS: readonly CommissionRuleVersionEvent[] = ['DRAFT_CREATED', 'PUBLISH', 'REVOKE'];

export interface CommissionRuleVersionTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (CommissionRuleVersionState | null | '*')[];
  readonly event: CommissionRuleVersionEvent | null;
  readonly to: CommissionRuleVersionState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const COMMISSION_RULE_VERSION_TRANSITIONS: readonly CommissionRuleVersionTransitionRow[] = [
  {
    id: 'V1',
    from: [null],
    event: 'DRAFT_CREATED',
    to: 'draft',
    guard: '超管或被勾选规则发布权限的账号起草，草稿记录 base_version_id（BR-CALC-22）',
    test_id: 'AC-B2-03j#5',
  },
  {
    id: 'V2',
    from: ['draft'],
    event: 'PUBLISH',
    to: 'published',
    guard: 'BR-CALC-22：BR-CALC-06 完整性（含每个平台的 reserve_bp）与 BR-CALC-07 上限校验通过、试算差异报告生成成功；经 step-up 发布；当前最新已发布版本 = base_version_id；effective_from ≥ 发布时刻，且严格大于所有已发布且未撤销版本的 effective_from（BR-CALC-11）；写审计',
    test_id: 'AC-B2-03j#5',
  },
  {
    id: 'V3',
    from: ['published'],
    event: 'REVOKE',
    to: 'revoked',
    guard: 'BR-CALC-11：只许 effective_from 未到（当前时刻 < effective_from）的已发布版本撤销；须 step-up 并写审计，不改内容',
    test_id: 'AC-B2-03j#5',
  },
];

export type CommissionRuleVersionTransitionResult =
  | { ok: true; to: CommissionRuleVersionState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionCommissionRuleVersion(from: CommissionRuleVersionState | null, event: CommissionRuleVersionEvent): CommissionRuleVersionTransitionResult {
  for (const row of COMMISSION_RULE_VERSION_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as CommissionRuleVersionState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
