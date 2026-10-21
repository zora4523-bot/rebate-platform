import { addFen, applyReserve, splitByBp, subFen } from '@couli/money';

/** BR-FUND-08：这里接收联盟原值；Adapter 按件估算不能作为扣回依据。 */
export interface ClawbackCommissionInput {
  readonly full_invalid: boolean;
  readonly booked_n_fen: bigint;
  readonly settle_commission_fen: bigint | null;
  readonly settlement_seq_changed: boolean;
  readonly est_commission_fen: bigint | null;
  readonly estimate_changed: boolean;
  readonly rights_deduct_fen: bigint | null;
  readonly adapter_estimate_fen: bigint | null;
}

export type ClawbackCommissionResult =
  | {
      readonly kind: 'available';
      readonly n_new_fen: bigint;
      readonly source: 'full_invalid' | 'settlement' | 'estimate' | 'rights';
    }
  | { readonly kind: 'wait_commission' };

export interface AdjustmentObligation {
  readonly beneficiary_credit_id: string;
  readonly kind: 'first_credit' | 'reassign_credit' | 'deferred';
}

export interface AdjustmentBeneficiary {
  readonly user_id: string;
  readonly role: 'self' | 'share' | 'direct' | 'indirect';
  readonly ratio_bp: bigint;
  readonly status: 'active' | 'held' | 'forfeited';
  readonly risk_state: 'normal' | 'frozen' | 'appealing' | 'banned';
  readonly deletion_status: null | 'cooling' | 'processing' | 'done' | 'cancelled';
  readonly is_minor: boolean;
  /** 调用方按 BR-FUND-08 聚合：含 RESTORE 和坏账扣回，不含归平台正差。 */
  readonly net_fen: bigint;
  /** 仅传未完成义务；已关闭的历史义务不传入。 */
  readonly obligation: AdjustmentObligation | null;
}

export interface AdjustmentInput {
  readonly event: 'clawback' | 'settlement';
  readonly n_new_fen: bigint;
  readonly reserve_bp: bigint;
  readonly booked_base_fen: bigint;
  readonly booked_n_fen: bigint;
  /** COMMISSION_REVENUE 贷方净额，含没收及申诉补发借方。 */
  readonly platform_net_fen: bigint;
  /** 已选定的归属快照，按 user_id + role 区分，不能按用户合并角色。 */
  readonly beneficiaries: readonly AdjustmentBeneficiary[];
}

export interface AdjustmentBeneficiaryResult {
  readonly user_id: string;
  readonly role: AdjustmentBeneficiary['role'];
  readonly entitlement_fen: bigint;
  /** 新净额减旧净额；坏账扣回也计入。零差不生成凭证。 */
  readonly delta_fen: bigint;
  readonly net_after_fen: bigint;
  readonly posting: 'user_available' | 'bad_debt' | null;
  readonly forfeit_fen: bigint;
  readonly forfeit_reason: 'banned' | 'deleted' | 'minor' | null;
  readonly pending_before_fen: bigint;
  readonly pending_after_fen: bigint;
  /** open 由调用方分配新 ID；keep 复用原义务，不另开。 */
  readonly obligation_action: 'open' | 'keep' | 'done' | 'forfeited' | 'voided' | null;
  readonly beneficiary_credit_id: string | null;
  readonly append_forfeited_event: boolean;
}

export interface AdjustmentPlatformPosting {
  readonly amount_fen: bigint;
  readonly debit: 'COMMISSION_REVENUE' | 'UNION_RECEIVABLE';
  readonly credit: 'COMMISSION_REVENUE' | 'UNION_RECEIVABLE';
}

export interface AdjustmentPlan {
  readonly route: 'immediate' | 'approval' | 'none';
  readonly transition: 'R8' | 'R9' | 'R10' | null;
  readonly rebate_status: 'CREDITED' | 'CLAWED_BACK';
  readonly ledger_type: 'CLAWBACK' | 'SETTLE_ADJUST' | null;
  readonly reserve_fen: bigint;
  /** 拟记账后的成对值；approval 路只供预览，批准时须用当前输入重新计算。 */
  readonly booked_after: { readonly booked_base_fen: bigint; readonly booked_n_fen: bigint };
  readonly beneficiaries: readonly AdjustmentBeneficiaryResult[];
  readonly platform_after_fen: bigint;
  /** 新平台净额减旧净额；与 BR-FUND-08 的“平台扣回差额”符号相反。 */
  readonly platform_delta_fen: bigint;
  readonly platform_posting: AdjustmentPlatformPosting | null;
  readonly union_receivable_delta_fen: bigint;
  readonly void_pending_candidates: boolean;
}

export interface AdjustmentReceivableInput {
  readonly booked_n_before_fen: bigint;
  readonly n_new_fen: bigint;
  readonly pending_before_fen: bigint;
  readonly pending_after_fen: bigint;
  /** 实际全部拟写凭证对 UNION_RECEIVABLE 的借方净影响。 */
  readonly actual_delta_fen: bigint;
}

/**
 * 自检失败：输入的平台净额、受益人净额与待补记额不满足 BR-FUND-19 ⑤ 的等式，
 * 拟写凭证对 UNION_RECEIVABLE 的净影响不等于 BR-FUND-08 的期望值。调用方不得落账。
 */
export class AdjustmentReceivableMismatch extends Error {
  readonly expected_delta_fen: bigint;
  readonly actual_delta_fen: bigint;
  constructor(expected_delta_fen: bigint, actual_delta_fen: bigint) {
    super(
      `AdjustmentReceivableMismatch: expected ${expected_delta_fen.toString()}, actual ${actual_delta_fen.toString()}`,
    );
    this.name = 'AdjustmentReceivableMismatch';
    this.expected_delta_fen = expected_delta_fen;
    this.actual_delta_fen = actual_delta_fen;
  }
}

function positivePart(fen: bigint): bigint {
  return fen > 0n ? fen : 0n;
}

/** 缺佣金只返回判定，不做 S12 的待处理表写入或告警 I/O。 */
export function selectClawbackCommission(input: ClawbackCommissionInput): ClawbackCommissionResult {
  // 整单失效：N_new = 0，优先于其他来源。
  if (input.full_invalid) return { kind: 'available', n_new_fen: 0n, source: 'full_invalid' };
  // ① 本次事件带来的联盟新佣金（有效联盟佣金，BR-CALC-02）：
  //    结算佣金非空时只认新的结算记录（seq 变化），单独变化的预估佣金不算；
  //    结算佣金为空时是预估佣金的新值。保留负原值，正数部分由调用方 / 规划函数截取。
  if (input.settle_commission_fen !== null) {
    if (input.settlement_seq_changed) {
      return { kind: 'available', n_new_fen: input.settle_commission_fen, source: 'settlement' };
    }
  } else if (input.estimate_changed && input.est_commission_fen !== null) {
    return { kind: 'available', n_new_fen: input.est_commission_fen, source: 'estimate' };
  }
  // ② 联盟维权记录给出的应扣佣金：N_new = booked_n_fen − 应扣佣金，小于 0 按 0。
  if (input.rights_deduct_fen !== null) {
    const rest = subFen(input.booked_n_fen, input.rights_deduct_fen);
    return { kind: 'available', n_new_fen: positivePart(rest), source: 'rights' };
  }
  // ③ 都没有：不写扣回，等联盟数据；Adapter 按件估算（adapter_estimate_fen）不作依据。
  return { kind: 'wait_commission' };
}

type StateClass =
  | { readonly kind: 'forfeited' }
  | { readonly kind: 'forfeit'; readonly reason: 'banned' | 'deleted' | 'minor' }
  | { readonly kind: 'defer' }
  | { readonly kind: 'normal' };

function isDeleted(person: AdjustmentBeneficiary): boolean {
  return person.deletion_status === 'processing' || person.deletion_status === 'done';
}

/** BR-CALC-09 受益人状态规则的分类；永久性状态优先于可解除的冻结 / 申诉 / hold。 */
function classify(person: AdjustmentBeneficiary): StateClass {
  if (person.status === 'forfeited') return { kind: 'forfeited' };
  if (isDeleted(person)) return { kind: 'forfeit', reason: 'deleted' };
  if (person.risk_state === 'banned') return { kind: 'forfeit', reason: 'banned' };
  if (person.is_minor && person.role !== 'self') return { kind: 'forfeit', reason: 'minor' };
  if (
    person.status === 'held' ||
    person.risk_state === 'frozen' ||
    person.risk_state === 'appealing'
  ) {
    return { kind: 'defer' };
  }
  return { kind: 'normal' };
}

// ---------------------------------------------------------------------------
// 共享的纯计算：取整换算、重拆份额、逐受益人金额、平台差额与应收自检。
// 早退（无动作）与是否处置受益人不在这里决定，由结算补差 / 扣回两条路径各自决定。
// ---------------------------------------------------------------------------

interface Recalc {
  readonly n_positive_fen: bigint;
  readonly base_new_fen: bigint;
  readonly reserve_fen: bigint;
  readonly shares_new: readonly bigint[];
  readonly shares_old: readonly bigint[];
  /** BR-FUND-08 / BR-CALC-23 的 R8 条件：N 正数部分为 0，或原基数大于 0 而新基数为 0。 */
  readonly clawed_back: boolean;
}

function recalc(input: AdjustmentInput): Recalc {
  const n_positive_fen = positivePart(input.n_new_fen);
  // BR-CALC-02：用快照 reserve_bp 换算新基数，预留含取整尾差。
  const { after_reserve_fen: base_new_fen, reserve_fen } = applyReserve(
    input.n_new_fen,
    input.reserve_bp,
  );
  const ratios = input.beneficiaries.map((person) => person.ratio_bp);
  return {
    n_positive_fen,
    base_new_fen,
    reserve_fen,
    // BR-CALC-09：按新基数全额重拆，不对 ΔB 乘比例。
    shares_new: splitByBp(base_new_fen, ratios).shares,
    shares_old: splitByBp(input.booked_base_fen, ratios).shares,
    clawed_back: n_positive_fen === 0n || (input.booked_base_fen > 0n && base_new_fen === 0n),
  };
}

interface Row {
  readonly entitlement_fen: bigint;
  readonly delta_fen: bigint;
  readonly forfeit_fen: bigint;
  readonly forfeit_reason: AdjustmentBeneficiaryResult['forfeit_reason'];
  readonly pending_after_fen: bigint;
  readonly obligation_action: AdjustmentBeneficiaryResult['obligation_action'];
}

/** 每个受益人的计算现场：状态分类、新份额与本次之前的待补记额。 */
interface Seat {
  readonly person: AdjustmentBeneficiary;
  readonly state: StateClass;
  readonly share_new_fen: bigint;
  readonly pending_before_fen: bigint;
}

type RowPlanner = (seat: Seat) => Row;

function emptyRow(seat: Seat): Row {
  return {
    entitlement_fen: 0n,
    delta_fen: 0n,
    forfeit_fen: 0n,
    forfeit_reason: null,
    pending_after_fen: 0n,
    obligation_action: seat.person.obligation !== null ? 'keep' : null,
  };
}

/**
 * 受益人不补不扣、待补记额与义务原样（只用于结算补差的基数不变一路，BR-FUND-09 / BR-CALC-23）。
 * 应得仍按状态规则展示：forfeited 为 0，封禁 / 注销 / 未成年推广取重拆份额与净额的较小值。
 */
function rowRetained(seat: Seat): Row {
  const { person, state, share_new_fen } = seat;
  if (state.kind === 'forfeited') return emptyRow(seat);
  const entitlement_fen =
    state.kind === 'forfeit' && share_new_fen > person.net_fen ? person.net_fen : share_new_fen;
  return { ...emptyRow(seat), entitlement_fen, pending_after_fen: seat.pending_before_fen };
}

/** R8：新应得为 0，已入账净额全扣（注销者改记坏账由 posting 决定）；作废未完成义务。 */
function rowClawedBack(seat: Seat): Row {
  const { person, state } = seat;
  const voided = person.obligation !== null ? 'voided' : null;
  if (state.kind === 'forfeited') return { ...emptyRow(seat), obligation_action: voided };
  return { ...emptyRow(seat), delta_fen: subFen(0n, person.net_fen), obligation_action: voided };
}

/**
 * BR-CALC-09：按新基数重拆并按当前受益人状态处理差额。
 * positive='credit'：结算补差正差一路（获批时状态正常的正差整笔补给，义务完成）；
 * positive='defer'：结算补差负差一路与扣回事件（正常受益人的正差留作待补记额，不补给）。
 */
function rowRecalculated(seat: Seat, positive: 'credit' | 'defer'): Row {
  const { person, state, share_new_fen } = seat;
  const hasObligation = person.obligation !== null;
  const keepOrNull = hasObligation ? 'keep' : null;

  // forfeited：新应得恒为 0，不生成任何调整。
  if (state.kind === 'forfeited') return emptyRow(seat);

  const diff = subFen(share_new_fen, person.net_fen);

  if (state.kind === 'forfeit') {
    // 新应得取重拆份额与已有净额的较小值；多出的部分归平台。负差照扣（注销者记坏账）。
    // 有未完成义务的，剩余未履约金额整笔归了平台，义务记为没收（BR-FUND-04 ⑫）。
    return {
      entitlement_fen: diff > 0n ? person.net_fen : share_new_fen,
      delta_fen: diff > 0n ? 0n : diff,
      forfeit_fen: diff > 0n ? diff : 0n,
      forfeit_reason: diff > 0n || hasObligation ? state.reason : null,
      pending_after_fen: 0n,
      obligation_action: hasObligation ? 'forfeited' : null,
    };
  }

  const credit = state.kind === 'normal' && positive === 'credit';

  if (diff <= 0n) {
    // 负差（或零差）照常扣回 available；正差一路里正常受益人的义务视为完成。
    return {
      ...emptyRow(seat),
      entitlement_fen: share_new_fen,
      delta_fen: diff,
      obligation_action: credit && hasObligation ? 'done' : keepOrNull,
    };
  }

  if (credit) {
    // 正差获批时状态正常：整笔补给受益人，有未完成义务的记为完成。
    return {
      ...emptyRow(seat),
      entitlement_fen: share_new_fen,
      delta_fen: diff,
      obligation_action: hasObligation ? 'done' : null,
    };
  }

  // 冻结 / 申诉 / hold 的正差，或负差一路 / 扣回事件里正常受益人的正差：留作待补记额。
  return {
    ...emptyRow(seat),
    entitlement_fen: share_new_fen,
    pending_after_fen: diff,
    obligation_action: hasObligation ? 'keep' : 'open',
  };
}

interface Rows {
  readonly beneficiaries: readonly AdjustmentBeneficiaryResult[];
  /** Σ(新净额 + 待补记后)：平台以外仍归受益人的部分。 */
  readonly held_after_fen: bigint;
  readonly user_delta_fen: bigint;
  readonly pending_before_fen: bigint;
  readonly pending_after_fen: bigint;
  /** 所有受益人都无金额、无待补记变化、无义务处置。 */
  readonly untouched: boolean;
}

function planRows(input: AdjustmentInput, calc: Recalc, planner: RowPlanner): Rows {
  let held_after_fen = 0n;
  let user_delta_fen = 0n;
  let pending_before_total_fen = 0n;
  let pending_after_total_fen = 0n;
  let untouched = true;
  const beneficiaries = input.beneficiaries.map((person, i): AdjustmentBeneficiaryResult => {
    const state = classify(person);
    // 待补记额（BR-FUND-04 ⑫ / BR-FUND-19 ⑤）：只有未完成义务才有，按 booked_base 重拆减净额。
    const pending_before_fen =
      person.obligation !== null && state.kind !== 'forfeited'
        ? positivePart(subFen(calc.shares_old[i] ?? 0n, person.net_fen))
        : 0n;
    const row = planner({
      person,
      state,
      share_new_fen: calc.shares_new[i] ?? 0n,
      pending_before_fen,
    });
    const net_after_fen = addFen(person.net_fen, row.delta_fen);
    let posting: AdjustmentBeneficiaryResult['posting'] = null;
    if (row.delta_fen !== 0n) {
      posting = row.delta_fen < 0n && isDeleted(person) ? 'bad_debt' : 'user_available';
    }
    held_after_fen = addFen(held_after_fen, addFen(net_after_fen, row.pending_after_fen));
    user_delta_fen = addFen(user_delta_fen, row.delta_fen);
    pending_before_total_fen = addFen(pending_before_total_fen, pending_before_fen);
    pending_after_total_fen = addFen(pending_after_total_fen, row.pending_after_fen);
    if (
      row.delta_fen !== 0n ||
      row.forfeit_fen !== 0n ||
      row.pending_after_fen !== pending_before_fen ||
      (row.obligation_action !== null && row.obligation_action !== 'keep')
    ) {
      untouched = false;
    }
    return {
      user_id: person.user_id,
      role: person.role,
      entitlement_fen: row.entitlement_fen,
      delta_fen: row.delta_fen,
      net_after_fen,
      posting,
      forfeit_fen: row.forfeit_fen,
      forfeit_reason: row.forfeit_reason,
      pending_before_fen,
      pending_after_fen: row.pending_after_fen,
      obligation_action: row.obligation_action,
      beneficiary_credit_id: person.obligation?.beneficiary_credit_id ?? null,
      // 首次入账、改派入账义务整笔没收时追加 forfeited 事件；延后差额义务不追加（04 ⑫）。
      append_forfeited_event:
        row.obligation_action === 'forfeited' &&
        person.obligation !== null &&
        person.obligation.kind !== 'deferred',
    };
  });
  return {
    beneficiaries,
    held_after_fen,
    user_delta_fen,
    pending_before_fen: pending_before_total_fen,
    pending_after_fen: pending_after_total_fen,
    untouched,
  };
}

interface PlatformResult {
  readonly platform_after_fen: bigint;
  readonly platform_delta_fen: bigint;
  readonly platform_posting: AdjustmentPlatformPosting | null;
  readonly union_receivable_delta_fen: bigint;
}

/**
 * 平台差额与 UNION_RECEIVABLE 净影响自检（BR-FUND-08 / 09）。
 * 新平台应得 = 新留存 + 预留 + 归平台的部分 = N_new 正数部分 − Σ(受益人新净额 + 待补记额)。
 */
function settlePlatform(input: AdjustmentInput, calc: Recalc, rows: Rows): PlatformResult {
  const platform_after_fen = subFen(calc.n_positive_fen, rows.held_after_fen);
  const platform_delta_fen = subFen(platform_after_fen, input.platform_net_fen);
  let platform_posting: AdjustmentPlatformPosting | null = null;
  if (platform_delta_fen > 0n) {
    platform_posting = {
      amount_fen: platform_delta_fen,
      debit: 'UNION_RECEIVABLE',
      credit: 'COMMISSION_REVENUE',
    };
  } else if (platform_delta_fen < 0n) {
    platform_posting = {
      amount_fen: subFen(0n, platform_delta_fen),
      debit: 'COMMISSION_REVENUE',
      credit: 'UNION_RECEIVABLE',
    };
  }
  const union_receivable_delta_fen = addFen(rows.user_delta_fen, platform_delta_fen);
  const check = checkAdjustmentReceivable({
    booked_n_before_fen: input.booked_n_fen,
    n_new_fen: input.n_new_fen,
    pending_before_fen: rows.pending_before_fen,
    pending_after_fen: rows.pending_after_fen,
    actual_delta_fen: union_receivable_delta_fen,
  });
  if (!check.valid) {
    throw new AdjustmentReceivableMismatch(check.expected_delta_fen, union_receivable_delta_fen);
  }
  return { platform_after_fen, platform_delta_fen, platform_posting, union_receivable_delta_fen };
}

function noActionPlan(
  input: AdjustmentInput,
  calc: Recalc,
  rows: Rows,
  void_pending_candidates: boolean,
): AdjustmentPlan {
  return {
    route: 'none',
    transition: null,
    rebate_status: 'CREDITED',
    ledger_type: null,
    reserve_fen: calc.reserve_fen,
    booked_after: { booked_base_fen: input.booked_base_fen, booked_n_fen: input.booked_n_fen },
    beneficiaries: rows.beneficiaries,
    platform_after_fen: input.platform_net_fen,
    platform_delta_fen: 0n,
    platform_posting: null,
    union_receivable_delta_fen: 0n,
    void_pending_candidates,
  };
}

function postedPlan(
  calc: Recalc,
  rows: Rows,
  platform: PlatformResult,
  route: 'immediate' | 'approval',
  transition: 'R8' | 'R9' | 'R10',
  void_pending_candidates: boolean,
): AdjustmentPlan {
  return {
    route,
    transition,
    rebate_status: transition === 'R8' ? 'CLAWED_BACK' : 'CREDITED',
    ledger_type: transition === 'R10' ? 'SETTLE_ADJUST' : 'CLAWBACK',
    reserve_fen: calc.reserve_fen,
    booked_after: { booked_base_fen: calc.base_new_fen, booked_n_fen: calc.n_positive_fen },
    beneficiaries: rows.beneficiaries,
    ...platform,
    void_pending_candidates,
  };
}

// ---------------------------------------------------------------------------
// 路径一：结算补差（event=settlement，BR-FUND-09 / BR-CALC-23 (a)，迁移 R10 / R8）。
// ---------------------------------------------------------------------------

function planSettlementAdjustment(input: AdjustmentInput, calc: Recalc): AdjustmentPlan {
  const baseUnchanged = calc.base_new_fen === input.booked_base_fen;

  // BR-FUND-09 ③：结算基数与 booked_base_fen 相等、结算佣金正数部分也等于 booked_n_fen → 无动作。
  // 受益人与义务原样；不写凭证，不作废候选（结算事件不是扣回）。
  if (baseUnchanged && calc.n_positive_fen === input.booked_n_fen) {
    return noActionPlan(input, calc, planRows(input, calc, rowRetained), false);
  }

  // 新的结算佣金正数部分为 0，或原基数大于 0 而新基数为 0 → 按 BR-FUND-08 整单扣回（R8）。
  if (calc.clawed_back) {
    const rows = planRows(input, calc, rowClawedBack);
    return postedPlan(calc, rows, settlePlatform(input, calc, rows), 'immediate', 'R8', true);
  }

  // 整单分路：先比基数，相等时比结算佣金正数部分与 booked_n_fen。
  const route: 'immediate' | 'approval' =
    calc.base_new_fen < input.booked_base_fen ||
    (baseUnchanged && calc.n_positive_fen < input.booked_n_fen)
      ? 'immediate'
      : 'approval';

  // 基数不变而联盟佣金不同：受益人应得不变、差额为 0，只调平台（预留与留存重算），义务原样。
  // 基数变化：按 BR-CALC-09 重拆；负差一路正常受益人的正差留作待补记，正差一路整笔补给。
  const planner: RowPlanner = baseUnchanged
    ? rowRetained
    : (seat) => rowRecalculated(seat, route === 'approval' ? 'credit' : 'defer');
  const rows = planRows(input, calc, planner);
  return postedPlan(calc, rows, settlePlatform(input, calc, rows), route, 'R10', false);
}

// ---------------------------------------------------------------------------
// 路径二：扣回（event=clawback，BR-FUND-08 / BR-CALC-23 (b)，迁移 R9 / R8）。
// ---------------------------------------------------------------------------

function planClawbackAdjustment(input: AdjustmentInput, calc: Recalc): AdjustmentPlan {
  // N_new 正数部分为 0（不论原基数、不论原因），或原基数大于 0 而新基数为 0 → R8，作废未完成义务。
  if (calc.clawed_back) {
    const rows = planRows(input, calc, rowClawedBack);
    return postedPlan(calc, rows, settlePlatform(input, calc, rows), 'immediate', 'R8', true);
  }

  // 任何差额（含 0）都按 BR-CALC-09 用当前受益人状态重算：封禁 / 注销 / 未成年推广份额的
  // 未完成义务整笔归平台（没收），正常与冻结受益人的正差留作待补记；扣回不走审批。
  const rows = planRows(input, calc, (seat) => rowRecalculated(seat, 'defer'));
  const platform = settlePlatform(input, calc, rows);

  // 只有重算后确实一无变化（booked 成对值不变、受益人无金额 / 待补记 / 义务处置、平台差额 0）
  // 才不写凭证；扣回事务始终作废该单未批准的正差候选（BR-FUND-09 ②，决-10 A）。
  if (
    calc.base_new_fen === input.booked_base_fen &&
    calc.n_positive_fen === input.booked_n_fen &&
    rows.untouched &&
    platform.platform_delta_fen === 0n
  ) {
    return noActionPlan(input, calc, rows, true);
  }
  return postedPlan(calc, rows, platform, 'immediate', 'R9', true);
}

/**
 * BR-CALC-09/23、BR-FUND-08/09、04⑫：纯计算建议，不写余额、不迁移状态。
 * 结算补差与扣回是两条独立路径，早退条件与受益人处置各自决定，只共享取整与金额计算。
 * 首版淘礼金未接入，tlj_deduct_fen 恒 0（BR-CALC-02 细则）。金额运算只用 @couli/money。
 * 输入为 CREDITED 单、快照比例与锁内当前净额/状态；恢复后的身份以当前 status 传入。
 * approval 表示候选预览，不能直接落账；审批/seq/时序校验由调用方负责，批准时重新调用。
 * 义务关闭由调用方同事务关联实际凭证；平台零凭证时关联 seq / rights_event_id。
 * 不按 available 余额限扣，不触碰 frozen；幂等、锁与 app_id 隔离由调用方负责。
 * 输入不满足 BR-FUND-19 ⑤（平台净额 + Σ净额 + Σ待补记 = booked_n）时抛
 * AdjustmentReceivableMismatch（结算补差两值均相等的无动作除外）；比例或金额非法时抛
 * InvalidRatio / InvalidAmount。
 */
export function planCommissionAdjustment(input: AdjustmentInput): AdjustmentPlan {
  const calc = recalc(input);
  return input.event === 'settlement'
    ? planSettlementAdjustment(input, calc)
    : planClawbackAdjustment(input, calc);
}

/** BR-FUND-08：期望净影响 = max(N_new,0) - booked_n - (待补记后 - 待补记前)。 */
export function checkAdjustmentReceivable(input: AdjustmentReceivableInput): {
  readonly valid: boolean;
  readonly expected_delta_fen: bigint;
} {
  const pendingChange = subFen(input.pending_after_fen, input.pending_before_fen);
  const expected_delta_fen = subFen(
    subFen(positivePart(input.n_new_fen), input.booked_n_before_fen),
    pendingChange,
  );
  return { valid: input.actual_delta_fen === expected_delta_fen, expected_delta_fen };
}
