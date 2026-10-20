// B2-04e：入账计划纯函数（BR-FUND-05；BR-FUND-04 ⑩⑫；BR-FUND-19 ⑤；BR-CALC-02/04/13）。
// 无 I/O、无时钟、无随机；金额只经 @couli/money；不改变输入。
import { addFen, mulDivFloor, splitByBp, subFen } from '@couli/money';
import type { BuildVoucherParams } from '../../ledger/build-vouchers.ts';
import { orderKey, type LedgerRole } from '../../ledger/ledger.ts';

/** 锁后重读的状态；未成年人识别由调用方提供，不在纯函数中读时钟。 */
export interface CreditBeneficiaryState {
  readonly risk_state: 'normal' | 'frozen' | 'appealing' | 'banned';
  /** null 表示没有注销申请，其余沿用 contracts/enums/identity.yaml。 */
  readonly deletion_status: 'cooling' | 'processing' | 'done' | 'cancelled' | null;
  readonly is_minor: boolean;
}

/** 已选定快照中的受益人；不存在的层级、关闭的间推不传入，不重新选关系。 */
export interface CreditBeneficiary {
  readonly user_id: string;
  readonly role: LedgerRole;
  readonly ratio_bp: bigint;
  readonly snapshot_status: 'active' | 'forfeited';
  readonly current: CreditBeneficiaryState;
}

export type CreditForfeitReason = 'banned' | 'deleted' | 'minor';

/** 元数据与模板参数分开：buildVouchers 严格拒绝多余参数。 */
export interface CreditVoucherRequest {
  readonly template_id: string;
  readonly params: BuildVoucherParams;
  readonly forfeit_reason: CreditForfeitReason | null;
}

export interface InitialCreditInput {
  readonly platform: string;
  readonly sub_order_id: string;
  /** 调用方按 BR-CALC-02 由结算 N 和快照预留/淘礼金计算；不是预估金额。 */
  readonly b_credit_fen: bigint;
  readonly reserve_fen: bigint;
  readonly beneficiaries: readonly CreditBeneficiary[];
}

export interface InitialCreditDecision {
  readonly user_id: string;
  readonly role: LedgerRole;
  /** 快照已 forfeited 时为 0，其份额已进入基础留存。 */
  readonly share_fen: bigint;
  readonly action: 'credit' | 'held' | 'forfeited';
  readonly forfeit_reason: CreditForfeitReason | null;
  readonly append_forfeited_event: boolean;
  /** 仅正金额 held 开首次义务；稳定 ID 由事务层分配，函数不生成 ID。 */
  readonly open_initial_obligation: boolean;
}

export interface InitialCreditPlan {
  /** 保持输入受益人顺序；凭证按同序输出，基础平台CREDIT最后。 */
  readonly beneficiaries: readonly InitialCreditDecision[];
  /** 不含执行时没收和暂缓份额；快照阶段已失效的份额在此。 */
  readonly platform_retain_fen: bigint;
  readonly reserve_fen: bigint;
  readonly platform_credit_fen: bigint;
  readonly vouchers: readonly CreditVoucherRequest[];
}

export interface CreditNetPosition {
  readonly user_id: string;
  readonly role: LedgerRole;
  readonly ratio_bp: bigint;
  readonly snapshot_status: 'active' | 'forfeited';
  /** 调用方按 BR-FUND-19 ④ 汇总全口径净额，包含恢复与改记坏账的扣回。 */
  readonly net_fen: bigint;
  readonly has_open_obligation: boolean;
}

export interface CreditInvariantInput {
  readonly booked_base_fen: bigint;
  readonly booked_n_fen: bigint;
  /** 订单类凭证 UNION_RECEIVABLE 借正贷负的代数和。 */
  readonly union_receivable_net_fen: bigint;
  readonly positions: readonly CreditNetPosition[];
}

export interface CreditInvariantResult {
  readonly pending_credit_fen: bigint;
  readonly beneficiary_net_fen: bigint;
  readonly expected_receivable_fen: bigint;
  readonly receivable_matches: boolean;
  readonly beneficiary_net_within_base: boolean;
  readonly valid: boolean;
}

/** 纯函数输入标记，不是数据库枚举；持久化映射由调用方负责。R14 当前不开放。 */
export type CreditObligation = {
  readonly beneficiary_credit_id: string;
  readonly user_id: string;
  readonly role: LedgerRole;
  readonly snapshot_id: string;
  readonly status: 'open' | 'completed' | 'forfeited' | 'voided';
} & (
  | { readonly kind: 'initial' }
  | {
      readonly kind: 'deferred';
      /** 开立时固定，合并其他来源延后也不改；直接选择现有模板。 */
      readonly credit_template:
        | 'ADJ:DEFERRED:SETTLE_DIFF'
        | 'ADJ:DEFERRED:PRICE_COMPARE'
        | 'ADJ:DEFERRED:PRICE_PROTECT'
        | 'ADJ:DEFERRED:RESTORE';
    }
);

export interface BeneficiaryCreditInput extends CreditInvariantInput {
  readonly platform: string;
  readonly sub_order_id: string;
  readonly rebate_status: 'ESTIMATED' | 'WAITING' | 'CREDITED' | 'VOID' | 'CLAWED_BACK';
  readonly rights_pending: boolean;
  readonly settlement_seq: bigint;
  readonly expected_settlement_seq: bigint;
  readonly snapshot_id: string;
  readonly obligation: CreditObligation;
  readonly current: CreditBeneficiaryState;
}

export interface BeneficiaryCreditPlan {
  readonly beneficiary_credit_id: string;
  readonly action: 'credit' | 'deferred' | 'forfeited' | 'skipped';
  readonly remaining_fen: bigint;
  readonly obligation_action: 'keep' | 'complete' | 'forfeit';
  readonly append_forfeited_event: boolean;
  readonly forfeit_reason: CreditForfeitReason | null;
  readonly alert: boolean;
  readonly skip_reason:
    | 'order_not_credited'
    | 'rights_pending'
    | 'settlement_changed'
    | 'snapshot_changed'
    | 'obligation_closed'
    | 'invariant_mismatch'
    | null;
  readonly vouchers: readonly CreditVoucherRequest[];
}

/** BR-FUND-05 / BR-CALC-04,13：按 B 重拆，>0 才输出模板，不改变输入。
 * 重复 (user_id, role) 必须 RangeError，不能产出重复凭证或重复义务。
 * 金额/比例使用 @couli/money 校验与运算；分别抛 InvalidAmount/InvalidRatio。
 */
export function planInitialCredit(input: InitialCreditInput): InitialCreditPlan {
  const order_key = orderKey(input.platform, input.sub_order_id);
  const reserve_fen = nonNegativeFen(input.reserve_fen);
  assertUniqueIdentities(input.beneficiaries);
  // 全部快照比例一起校验（含快照已没收者），每份各自 floor（BR-CALC-08）。
  const floors = splitByBp(
    input.b_credit_fen,
    input.beneficiaries.map((p) => p.ratio_bp),
  ).shares;

  const decisions: InitialCreditDecision[] = [];
  const vouchers: CreditVoucherRequest[] = [];
  let assigned = 0n;
  input.beneficiaries.forEach((p, index) => {
    assertSnapshotStatus(p.snapshot_status);
    if (p.snapshot_status === 'forfeited') {
      // BR-CALC-13：快照阶段已没收终局不变，份额留在基础平台留存，不顺延、不转给他人。
      decisions.push(decision(p, 0n, 'forfeited', null, false, false));
      return;
    }
    const share_fen = floors[index];
    if (share_fen === undefined) throw new Error('planInitialCredit: missing share');
    // 执行时的份额（入账、暂缓、没收）都不进基础平台留存。
    assigned = addFen(assigned, share_fen);
    const status = classify(p.current, p.role);
    if (status.kind === 'forfeit') {
      decisions.push(decision(p, share_fen, 'forfeited', status.reason, true, false));
      if (share_fen > 0n) {
        vouchers.push(forfeitVoucher(order_key, input.platform, p, share_fen, status.reason));
      }
    } else if (status.kind === 'hold') {
      // BR-FUND-04 ⑩：只暂缓本人；正金额才开首次入账义务，ID 由事务层分配。
      decisions.push(decision(p, share_fen, 'held', null, false, share_fen > 0n));
    } else {
      decisions.push(decision(p, share_fen, 'credit', null, false, false));
      if (share_fen > 0n) vouchers.push(creditVoucher(order_key, input.platform, p, share_fen));
    }
  });

  const platform_retain_fen = subFen(input.b_credit_fen, assigned, { nonNegative: true });
  const platform_credit_fen = addFen(platform_retain_fen, reserve_fen);
  if (platform_credit_fen > 0n) {
    vouchers.push({
      template_id: 'CREDIT:PLATFORM',
      params: { order_key, platform: input.platform, platform_credit_fen },
      forfeit_reason: null,
    });
  }
  return {
    beneficiaries: decisions,
    platform_retain_fen,
    reserve_fen,
    platform_credit_fen,
    vouchers,
  };
}

/** BR-FUND-19 ⑤：只对未完成义务计 max(0, 重拆份额 - 净额)，同时检查两项。
 * positions 必须包含本单全部受益人净额；重复(user_id, role)抛RangeError。
 */
export function checkCreditInvariant(input: CreditInvariantInput): CreditInvariantResult {
  const booked_base_fen = nonNegativeFen(input.booked_base_fen);
  assertUniqueIdentities(input.positions);
  let pending_credit_fen = 0n;
  let beneficiary_net_fen = 0n;
  for (const p of input.positions) {
    beneficiary_net_fen = addFen(beneficiary_net_fen, p.net_fen);
    // 逐人截零后再求和，不以一人的超额抵销另一人的待补记额。
    pending_credit_fen = addFen(pending_credit_fen, pendingOf(booked_base_fen, p));
  }
  const expected_receivable_fen = subFen(input.booked_n_fen, pending_credit_fen);
  const receivable_matches = input.union_receivable_net_fen === expected_receivable_fen;
  const beneficiary_net_within_base = beneficiary_net_fen <= booked_base_fen;
  return {
    pending_credit_fen,
    beneficiary_net_fen,
    expected_receivable_fen,
    receivable_matches,
    beneficiary_net_within_base,
    valid: receivable_matches && beneficiary_net_within_base,
  };
}

/** BR-FUND-04 ⑫：先重验执行条件与整单⑤，再按当前状态决定补记/暂缓/没收。
 * 跳过时 remaining_fen=0、不处置义务、不输出凭证；⑤不成立另返回 alert=true。
 * 金额为0仍按正常/失效状态关闭义务；冻结/申诉则保持未完成。
 * 待执行的未完成义务须恰好匹配一个 positions 条目且 has_open_obligation=true，
 * 不一致是调用方输入错误，抛 RangeError，不能产生资金计划。
 */
export function planBeneficiaryCredit(input: BeneficiaryCreditInput): BeneficiaryCreditPlan {
  const obligation = input.obligation;
  const id = obligation.beneficiary_credit_id;
  assertObligation(obligation);

  // 锁内重验执行条件：任一不满足则跳过，不处置义务。
  if (input.rebate_status !== 'CREDITED') return skipped(id, 'order_not_credited', false);
  if (input.rights_pending) return skipped(id, 'rights_pending', false);
  if (input.settlement_seq !== input.expected_settlement_seq) {
    return skipped(id, 'settlement_changed', false);
  }
  if (obligation.snapshot_id !== input.snapshot_id) return skipped(id, 'snapshot_changed', false);
  if (obligation.status !== 'open') return skipped(id, 'obligation_closed', false);

  const matches = input.positions.filter(
    (p) => p.user_id === obligation.user_id && p.role === obligation.role,
  );
  const target = matches[0];
  if (matches.length !== 1 || target === undefined || !target.has_open_obligation) {
    throw new RangeError('open obligation must match exactly one open position (user_id, role)');
  }

  // 整单 ⑤ 不成立：有义务的份额已被处置而义务未关闭，跳过并告警，不写凭证。
  const invariant = checkCreditInvariant({
    booked_base_fen: input.booked_base_fen,
    booked_n_fen: input.booked_n_fen,
    union_receivable_net_fen: input.union_receivable_net_fen,
    positions: input.positions,
  });
  if (!invariant.valid) return skipped(id, 'invariant_mismatch', true);

  const remaining_fen = pendingOf(input.booked_base_fen, target);
  const order_key = orderKey(input.platform, input.sub_order_id);
  const status = classify(input.current, obligation.role);
  const initial = obligation.kind === 'initial';

  if (status.kind === 'hold') {
    return plan(id, 'deferred', remaining_fen, 'keep', false, null, []);
  }
  if (status.kind === 'forfeit') {
    // 首次入账义务是首次整份没收（与 R5 同键、追加 forfeited 事件）；
    // 延后差额义务只没收剩余未履约金额，不追加事件。
    const vouchers: CreditVoucherRequest[] = [];
    if (remaining_fen > 0n) {
      vouchers.push(
        initial
          ? forfeitVoucher(order_key, input.platform, obligation, remaining_fen, status.reason)
          : {
              template_id: 'FORFEIT:DEFERRED',
              params: {
                order_key,
                platform: input.platform,
                uid: obligation.user_id,
                role: obligation.role,
                beneficiary_credit_id: id,
                pending_credit_fen: remaining_fen,
              },
              forfeit_reason: status.reason,
            },
      );
    }
    return plan(id, 'forfeited', remaining_fen, 'forfeit', initial, status.reason, vouchers);
  }

  const vouchers: CreditVoucherRequest[] = [];
  if (remaining_fen > 0n) {
    vouchers.push(
      obligation.kind === 'initial'
        ? creditVoucher(order_key, input.platform, obligation, remaining_fen)
        : {
            template_id: obligation.credit_template,
            params: {
              order_key,
              platform: input.platform,
              user_id: obligation.user_id,
              role: obligation.role,
              beneficiary_credit_id: id,
              pending_credit_fen: remaining_fen,
            },
            forfeit_reason: null,
          },
    );
  }
  return plan(id, 'credit', remaining_fen, 'complete', false, null, vouchers);
}

type StateClass =
  | { readonly kind: 'credit' }
  | { readonly kind: 'hold' }
  | { readonly kind: 'forfeit'; readonly reason: CreditForfeitReason };

const DEFERRED_TEMPLATES: readonly string[] = [
  'ADJ:DEFERRED:SETTLE_DIFF',
  'ADJ:DEFERRED:PRICE_COMPARE',
  'ADJ:DEFERRED:PRICE_PROTECT',
  'ADJ:DEFERRED:RESTORE',
];
const OBLIGATION_STATUSES: readonly string[] = ['open', 'completed', 'forfeited', 'voided'];

/**
 * BR-CALC-13 执行时逐受益人判定（锁后重读的状态）。失效优先于暂缓；多个失效原因并存时
 * 依次取 deleted、banned、minor（08 未定先后，只影响 forfeit_reason，不影响金额与动作）。
 * 未成年人只没收推广份额（share/direct/indirect），本人返利照常（BR-ID-26 (b)）。
 * 注销冷静期与已撤销注销不算失效。
 */
function classify(state: CreditBeneficiaryState, role: LedgerRole): StateClass {
  const deletion: unknown = state.deletion_status;
  if (deletion === 'processing' || deletion === 'done')
    return { kind: 'forfeit', reason: 'deleted' };
  if (deletion !== null && deletion !== 'cooling' && deletion !== 'cancelled') {
    throw new RangeError('unknown deletion_status');
  }
  const risk: unknown = state.risk_state;
  if (risk === 'banned') return { kind: 'forfeit', reason: 'banned' };
  if (state.is_minor !== true && state.is_minor !== false) throw new RangeError('bad is_minor');
  if (state.is_minor && role !== 'self') return { kind: 'forfeit', reason: 'minor' };
  if (risk === 'frozen' || risk === 'appealing') return { kind: 'hold' };
  if (risk !== 'normal') throw new RangeError('unknown risk_state');
  return { kind: 'credit' };
}

/** 剩余未履约金额：只对未完成义务计 max(0, floor(B × ratio / 10000) − 净额)。 */
function pendingOf(booked_base_fen: bigint, p: CreditNetPosition): bigint {
  assertSnapshotStatus(p.snapshot_status);
  const due = mulDivFloor(booked_base_fen, p.ratio_bp, 10000n);
  if (!p.has_open_obligation || p.snapshot_status === 'forfeited') return 0n;
  const gap = subFen(due, p.net_fen);
  return gap > 0n ? gap : 0n;
}

function nonNegativeFen(value: bigint): bigint {
  return subFen(value, 0n, { nonNegative: true });
}

function assertUniqueIdentities(
  items: readonly { readonly user_id: string; readonly role: LedgerRole }[],
): void {
  const seen = new Set<string>();
  for (const item of items) {
    const identity = JSON.stringify([item.user_id, item.role]);
    if (seen.has(identity)) throw new RangeError('duplicate (user_id, role)');
    seen.add(identity);
  }
}

function assertSnapshotStatus(status: unknown): void {
  if (status !== 'active' && status !== 'forfeited') {
    throw new RangeError('snapshot_status must be active or forfeited');
  }
}

function assertObligation(obligation: CreditObligation): void {
  if (!OBLIGATION_STATUSES.includes(obligation.status)) {
    throw new RangeError('unknown obligation status');
  }
  const kind: unknown = obligation.kind;
  if (kind === 'deferred') {
    const template: unknown = (obligation as { readonly credit_template?: unknown })
      .credit_template;
    if (typeof template !== 'string' || !DEFERRED_TEMPLATES.includes(template)) {
      throw new RangeError('unknown deferred credit_template');
    }
  } else if (kind !== 'initial') {
    throw new RangeError('unknown obligation kind');
  }
}

function decision(
  p: CreditBeneficiary,
  share_fen: bigint,
  action: InitialCreditDecision['action'],
  forfeit_reason: CreditForfeitReason | null,
  append_forfeited_event: boolean,
  open_initial_obligation: boolean,
): InitialCreditDecision {
  return {
    user_id: p.user_id,
    role: p.role,
    share_fen,
    action,
    forfeit_reason,
    append_forfeited_event,
    open_initial_obligation,
  };
}

function creditVoucher(
  order_key: string,
  platform: string,
  p: { readonly user_id: string; readonly role: LedgerRole },
  share_fen: bigint,
): CreditVoucherRequest {
  return {
    template_id: `CREDIT:${p.role.toUpperCase()}`,
    params: { order_key, platform, user_id: p.user_id, role: p.role, share_fen },
    forfeit_reason: null,
  };
}

function forfeitVoucher(
  order_key: string,
  platform: string,
  p: { readonly user_id: string; readonly role: LedgerRole },
  share_fen: bigint,
  forfeit_reason: CreditForfeitReason,
): CreditVoucherRequest {
  return {
    template_id: 'FORFEIT',
    params: { order_key, platform, uid: p.user_id, role: p.role, share_fen },
    forfeit_reason,
  };
}

function plan(
  beneficiary_credit_id: string,
  action: BeneficiaryCreditPlan['action'],
  remaining_fen: bigint,
  obligation_action: BeneficiaryCreditPlan['obligation_action'],
  append_forfeited_event: boolean,
  forfeit_reason: CreditForfeitReason | null,
  vouchers: readonly CreditVoucherRequest[],
): BeneficiaryCreditPlan {
  return {
    beneficiary_credit_id,
    action,
    remaining_fen,
    obligation_action,
    append_forfeited_event,
    forfeit_reason,
    alert: false,
    skip_reason: null,
    vouchers,
  };
}

function skipped(
  beneficiary_credit_id: string,
  skip_reason: NonNullable<BeneficiaryCreditPlan['skip_reason']>,
  alert: boolean,
): BeneficiaryCreditPlan {
  return {
    beneficiary_credit_id,
    action: 'skipped',
    remaining_fen: 0n,
    obligation_action: 'keep',
    append_forfeited_event: false,
    forfeit_reason: null,
    alert,
    skip_reason,
    vouchers: [],
  };
}
