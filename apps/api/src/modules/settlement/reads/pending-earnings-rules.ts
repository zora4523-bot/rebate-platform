// B2-04x 纯函数：BR-CALC-02 有效联盟佣金换算基数、按快照比例逐角色拆份额（被剥夺的为 0），
// 以及预估类读取用到的配置值解析。不做 I/O、不读时钟；金额只经 @couli/money。
import { applyReserve, splitByBp, subFen } from '@couli/money';

export type PendingRole = 'self' | 'share' | 'direct' | 'indirect';

export interface PendingBeneficiary {
  readonly userId: string;
  readonly role: PendingRole;
  readonly ratioBp: number;
  readonly initialStatus: 'active' | 'forfeited';
}

export interface PendingForfeitedEvent {
  readonly userId: string;
  readonly role: PendingRole;
}

export interface PendingShare {
  readonly userId: string;
  readonly role: PendingRole;
  readonly amountFen: bigint;
}

/**
 * BR-CALC-02 取值阶段：settle_commission_fen 非空（含 0 与负数）时只取结算收入，否则取最新预估。
 * 两者都为空时佣金未知，返回 null（调用方按 0 份额处理，不臆造金额）。
 */
export function effectiveCommissionFen(
  estCommissionFen: bigint | null,
  settleCommissionFen: bigint | null,
): bigint | null {
  if (settleCommissionFen !== null) return settleCommissionFen;
  return estCommissionFen;
}

/** BR-CALC-02：B = max(0, floor(max(0,N) × (10000 − reserve_bp) / 10000) − tlj_deduct_fen)。 */
export function pendingBaseFen(nFen: bigint, reserveBp: number, tljDeductFen: bigint): bigint {
  const afterReserve = applyReserve(nFen, BigInt(reserveBp)).after_reserve_fen;
  const base = subFen(afterReserve, tljDeductFen);
  return base > 0n ? base : 0n;
}

function forfeitKey(userId: string, role: PendingRole): string {
  return `${role}\u0000${userId}`;
}

/**
 * BR-CALC-08 / BR-CALC-13：每个受益角色各自按快照比例向下取整；快照初始 forfeited 或其后出现
 * forfeited 事件的受益角色份额为 0（归平台），其余角色份额不受影响。顺序与快照一致。
 */
export function splitPendingShares(
  baseFen: bigint,
  beneficiaries: readonly PendingBeneficiary[],
  forfeitedEvents: readonly PendingForfeitedEvent[],
): PendingShare[] {
  const forfeited = new Set(forfeitedEvents.map((e) => forfeitKey(e.userId, e.role)));
  const active = beneficiaries.map(
    (b) => b.initialStatus !== 'forfeited' && !forfeited.has(forfeitKey(b.userId, b.role)),
  );
  const { shares } = splitByBp(
    baseFen,
    beneficiaries.map((b, i) => (active[i] === true ? BigInt(b.ratioBp) : 0n)),
  );
  return beneficiaries.flatMap((b, i) =>
    active[i] === true ? [{ userId: b.userId, role: b.role, amountFen: shares[i] ?? 0n }] : [],
  );
}

/** credit.enabled.<platform>（BR-CALC-03）：默认 off，只有明确开启才算开。 */
export function creditEnabledValue(value: unknown): boolean {
  return value === true || value === 'on' || value === 'true';
}

/** 整数配置：未配置取 08 默认；整数或纯数字串照用；其他值是配置错误，抛 RangeError。 */
export function integerConfig(value: unknown, key: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^[0-9]{1,6}$/.test(value)) return Number(value);
  throw new RangeError(`config ${key} must be an integer`);
}

/** YYYY-MM 字符串按字典序即时间序；返回较早者（null 视为无）。 */
export function earlierPeriod(current: string | null, candidate: string): string {
  return current === null || candidate < current ? candidate : current;
}
