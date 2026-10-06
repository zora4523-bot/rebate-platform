// union_pids.status transition table (BR-ATTR-02: pending → active → retired, forward only; no
// delete; BR-ATTR-28: pending is whitelisted but never converts). Pure: no Nest, no data access.
//
// TODO(规划/11 §9.2): 改为生成的 transition() — blocked on 状态机生成器（状态机双份盲录与比对尚未产出生成物）。
// Until then this function is the single place that says which status changes are legal; the
// service applies it with a row_version CAS (ADR-0001 §4.1).

export type PidStatus = 'pending' | 'active' | 'retired';

const NEXT: Readonly<Record<PidStatus, PidStatus | null>> = Object.freeze({
  pending: 'active',
  active: 'retired',
  retired: null,
});

export function isPidStatus(value: unknown): value is PidStatus {
  return value === 'pending' || value === 'active' || value === 'retired';
}

/** True only for pending → active and active → retired. Unknown values are never legal. */
export function canTransitionPid(from: unknown, to: unknown): boolean {
  return isPidStatus(from) && isPidStatus(to) && NEXT[from] === to;
}
