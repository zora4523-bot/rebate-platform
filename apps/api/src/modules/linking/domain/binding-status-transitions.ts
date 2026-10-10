// union_bindings.status transition table (规划/08 BR-ID-17 细则「pending_auth 不产生」, BR-ID-19
// 唯一与冷却, BR-ID-20 blocked / 释放 / 重置授权 / 停用与恢复返利, BR-ID-21 巡检失效, BR-ID-31 封禁与
// 解封; shape: 规划/04 §4.4 union_binding_status). Pure: no Nest, no data access, erasable syntax
// only.
//
// TODO(规划/11 §4.5): 换用生成的 transition() — blocked on CT-10 状态机生成器（approvals #26）
// Until then this function is the single place that says which union_bindings.status changes are
// legal; linking (the table's only writer) applies it before its row_version CAS.
//
// - no row yet (from = null) → active: a user authorization writes the row active directly
//   (pending_auth is never produced, BR-ID-17 细则)
// - pending_auth (legacy value, never produced) → active (authorized) | blocked (ban, deletion)
// - active → invalid (BR-ID-21 inspection) | blocked (ban, admin_disable, deletion) | released
//   (后台重置授权, BR-ID-20)
// - invalid → active (re-authorization with the same relation_id, BR-ID-21) | blocked | released
//   (重置授权 applies to active and invalid)
// - blocked → invalid (解封 for ban, 恢复返利 for admin_disable; the user re-authorizes, BR-ID-20)
//   | released (blocked_reason=deletion, the daily release task after 180 days)
// - released → active (the user's own row restored while it is still cooling, BR-ID-19; whether it
//   is still cooling is the caller's check)
// - unbound (allowed by the 0018 CHECK; the projection value of "no binding", not produced by the
//   current writers) → active (the user authorized) — kept as an explicit edge so a stored row
//   still goes through this single entry (approvals #26)
// - the same status again is not a transition (no write)

export type BindingStatus =
  'unbound' | 'pending_auth' | 'active' | 'invalid' | 'blocked' | 'released';

const NEXT: Readonly<Record<BindingStatus, readonly BindingStatus[]>> = Object.freeze({
  unbound: Object.freeze(['active'] as const),
  pending_auth: Object.freeze(['active', 'blocked'] as const),
  active: Object.freeze(['invalid', 'blocked', 'released'] as const),
  invalid: Object.freeze(['active', 'blocked', 'released'] as const),
  blocked: Object.freeze(['invalid', 'released'] as const),
  released: Object.freeze(['active'] as const),
});

export function isBindingStatus(value: unknown): value is BindingStatus {
  return (
    value === 'unbound' ||
    value === 'pending_auth' ||
    value === 'active' ||
    value === 'invalid' ||
    value === 'blocked' ||
    value === 'released'
  );
}

/** True for a legal change of union_bindings.status; from = null means no row exists yet. */
export function canTransitionBinding(from: unknown, to: unknown): boolean {
  if (!isBindingStatus(to)) return false;
  if (from === null) return to === 'active';
  if (!isBindingStatus(from)) return false;
  return NEXT[from].includes(to);
}
