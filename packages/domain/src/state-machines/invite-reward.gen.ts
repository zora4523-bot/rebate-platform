// 生成物，勿手改。来源：specs/state-machines/invite-reward.yaml（字段 status）。
// 改 yaml 后重新生成：node packages/domain/scripts/state-machines.ts（--verify 只比对）。
// 守卫只作说明，transition 只判定表内合法性；守卫、记账与副作用由调用方负责。

export type InviteRewardState =
  | 'qualified'
  | 'deferred'
  | 'processed'
  | 'voided'
  | 'budget_exhausted';

export const INVITE_REWARD_STATES: readonly InviteRewardState[] = ['qualified', 'deferred', 'processed', 'voided', 'budget_exhausted'];

export type InviteRewardEvent =
  | 'DEFER'
  | 'PROCESS'
  | 'VOID';

export const INVITE_REWARD_EVENTS: readonly InviteRewardEvent[] = ['DEFER', 'PROCESS', 'VOID'];

export interface InviteRewardTransitionRow {
  readonly id: string;
  readonly kind?: 'transition' | 'backward' | 'same_state';
  readonly from: readonly (InviteRewardState | null | '*')[];
  readonly event: InviteRewardEvent | null;
  readonly to: InviteRewardState | 'same';
  readonly guard: string;
  readonly test_id: string;
}

export const INVITE_REWARD_TRANSITIONS: readonly InviteRewardTransitionRow[] = [
  {
    id: 'R1',
    from: ['qualified'],
    event: 'DEFER',
    to: 'deferred',
    guard: '已触发（trigger_order_id 非空），判定顺序第 1–5 步未作废且至少一方待发；第 6 步暂停发放开关 payout_paused 为 on，或当日预算条件更新影响 0 行（当日不够），次日 00:00 +08:00 起按触发时刻先后重试',
    test_id: 'SM-IRW-R1',
  },
  {
    id: 'R2',
    from: ['deferred'],
    event: 'DEFER',
    to: 'same',
    guard: '已顺延的记录重试时从第 1 步判起，到第 6 步仍暂停发放或当日预算仍不够，状态不变，等次日或恢复后再判',
    test_id: 'SM-IRW-R2',
  },
  {
    id: 'R3',
    from: ['qualified', 'deferred'],
    event: 'PROCESS',
    to: 'processed',
    guard: '两方结果都已定：第 4 步双方防刷命中两方都记不发；或第 5 步后剩余要发的一方或两方在第 6 步扣到当日预算、第 7 步写好 REWARD 凭证；两方结果与不发原因同次写入（0055 要求 processed 时两方结果非空）',
    test_id: 'SM-IRW-R3',
  },
  {
    id: 'R4',
    from: ['qualified', 'deferred'],
    event: 'VOID',
    to: 'voided',
    guard: '第 2 步被邀请人当前 parent_id 已不是资格记录里的邀请人（relation_changed），或第 3 步触发订单已非 CREDITED、被扣回或在维权中（order_clawed_back / order_rights）；释放两方占用，void_reason 必填',
    test_id: 'SM-IRW-R4',
  },
];

export type InviteRewardTransitionResult =
  | { ok: true; to: InviteRewardState; id: string; noop: boolean }
  | { ok: false; reason: 'illegal' | 'backward'; id: string | null };

export function transitionInviteReward(from: InviteRewardState | null, event: InviteRewardEvent): InviteRewardTransitionResult {
  for (const row of INVITE_REWARD_TRANSITIONS) {
    if (row.kind === 'backward' || row.kind === 'same_state') continue;
    if (row.event !== event || !row.from.includes(from)) continue;
    if (row.to === 'same') {
      return { ok: true, to: from as InviteRewardState, id: row.id, noop: true };
    }
    return { ok: true, to: row.to, id: row.id, noop: false };
  }
  return { ok: false, reason: 'illegal', id: null };
}
