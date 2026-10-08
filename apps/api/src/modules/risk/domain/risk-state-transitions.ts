// user_risk_state.state transition table (规划/08 BR-ID-31 封禁与解封, BR-ID-36 冻结 / 申诉;
// task B1-03h §11 item 4). Pure: no Nest, no data access, erasable syntax only.
//
// TODO(规划/11 §4.5): 换用生成的 transition() — blocked on CT-04 状态机生成器
// Until then this function is the single place that says which risk state changes are legal; the
// state service (../application/risk-state.ts) applies it before its row_version CAS.
//
// - normal → banned | frozen
// - frozen → normal (expiry or manual release) | banned | appealing
// - banned → normal (unban) | appealing
// - appealing → normal | banned | frozen (by the appeal's conclusion, the previous state included)
// - the same state again (a rewrite of reason, category or frozen_until, e.g. extending a freeze)
// - no row yet (from = null): the user's first row may hold any state (the initial row of a user,
//   which the rule tests and a backfill seed directly; the event still reports from = normal)

export type RiskStateValue = 'normal' | 'frozen' | 'banned' | 'appealing';

const NEXT: Readonly<Record<RiskStateValue, readonly RiskStateValue[]>> = Object.freeze({
  normal: Object.freeze(['banned', 'frozen'] as const),
  frozen: Object.freeze(['normal', 'banned', 'appealing'] as const),
  banned: Object.freeze(['normal', 'appealing'] as const),
  appealing: Object.freeze(['normal', 'banned', 'frozen'] as const),
});

export function isRiskStateValue(value: unknown): value is RiskStateValue {
  return value === 'normal' || value === 'frozen' || value === 'banned' || value === 'appealing';
}

/** True for a legal change of user_risk_state.state; from = null means the user has no row yet. */
export function canTransitionRiskState(from: unknown, to: unknown): boolean {
  if (!isRiskStateValue(to)) return false;
  if (from === null) return true;
  if (!isRiskStateValue(from)) return false;
  return from === to || NEXT[from].includes(to);
}
