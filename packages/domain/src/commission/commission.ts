import { addFen, applyReserve, InvalidAmount, splitByBp, subFen } from '@couli/money';

/** 调用方已按平台、订单类型、paid_at 选好每个角色自己的比例和历史关系。 */
export interface CommissionBeneficiary {
  readonly user_id: string;
  readonly ratio_bp: bigint;
  readonly status: 'active' | 'forfeited';
}

export interface SplitCommissionInput {
  readonly n_base_fen: bigint;
  readonly reserve_bp: bigint;
  readonly tlj_deduct_fen: bigint;
  readonly order_type: 'self' | 'share';
  readonly indirect_enabled: boolean;
  readonly owner: CommissionBeneficiary;
  readonly direct?: CommissionBeneficiary | null;
  readonly indirect?: CommissionBeneficiary | null;
}

export interface CommissionShare {
  readonly role: 'self' | 'share' | 'direct' | 'indirect';
  readonly user_id: string;
  readonly ratio_bp: bigint;
  readonly amount_fen: bigint;
}

/** 纯函数只返回告警信号，由调用方负责记录，不在这里写日志。 */
export type CommissionWarning = 'INDIRECT_SAME_PERSON';

export interface SplitCommissionResult {
  readonly reserve_fen: bigint;
  readonly base_fen: bigint;
  readonly shares: readonly CommissionShare[];
  readonly platform_retain_fen: bigint;
  readonly warnings: readonly CommissionWarning[];
}

export interface QuoteRebateInput {
  /** UnionAdapter 已算好的非负推广者收入；这里不重复扣技术服务费。 */
  readonly n_quote_fen: bigint;
  readonly reserve_bp: bigint;
  /** 调用方按报价时刻、查看者等级、order_type 选出的本人比例。 */
  readonly r_own_bp: bigint;
}

/**
 * BR-CALC-02/04/05/08/13/24。先扣预留，再扣淘礼金并将 B 截到零。
 * shares 按本人、直推、间推顺序输出；缺关系、关闭间推、间推同人均不输出该角色。
 * 有关系但 forfeited 的角色保留身份和原比例，amount_fen 恒为零；直推 forfeited
 * 不切断间推。间推与 owner/direct 同人时返回一次 INDIRECT_SAME_PERSON。
 * 所有传入比例必须为 bigint 0..10000，传入的三角色比例总和不得超过 10000；
 * 这是运算防御边界，发布端的 8000 上限另行校验，不由本函数选择或发布规则。
 * n_base_fen 可负；tlj_deduct_fen 非负；非法金额/比例分别抛 InvalidAmount/InvalidRatio。
 * 不改变输入，不读取时钟或外部状态。实现必须使用 @couli/money 运算。
 */
export function splitCommission(input: SplitCommissionInput): SplitCommissionResult {
  assertNonNegativeFen(input.tlj_deduct_fen);
  // BR-CALC-02：N ≤ 0 先置 0；预留含取整尾差归平台。applyReserve 校验 N 与 reserve_bp。
  const { after_reserve_fen, reserve_fen } = applyReserve(input.n_base_fen, input.reserve_bp);
  const base_fen =
    after_reserve_fen > input.tlj_deduct_fen ? subFen(after_reserve_fen, input.tlj_deduct_fen) : 0n;

  const owner = input.owner;
  const direct = input.direct ?? null;
  const indirect = input.indirect ?? null;
  assertStatus(owner);
  if (direct !== null) assertStatus(direct);
  if (indirect !== null) assertStatus(indirect);

  // 所有传入角色的比例都先校验（含关闭间推或同人时不输出的间推），总和 ≤ 10000；
  // 基数为 0 也照样校验。每份各自 floor（BR-CALC-08），由 splitByBp 完成。
  const passed: CommissionBeneficiary[] = [owner];
  if (direct !== null) passed.push(direct);
  if (indirect !== null) passed.push(indirect);
  const floors = splitByBp(
    base_fen,
    passed.map((person) => person.ratio_bp),
  ).shares;

  const shares: CommissionShare[] = [];
  const warnings: CommissionWarning[] = [];
  const append = (role: CommissionShare['role'], person: CommissionBeneficiary, index: number) => {
    const floor = floors[index];
    if (floor === undefined) throw new Error('splitCommission: missing share');
    shares.push({
      role,
      user_id: person.user_id,
      ratio_bp: person.ratio_bp,
      // BR-CALC-13：forfeited 恒 0，份额留给平台，不顺延、不转给其他受益人。
      amount_fen: person.status === 'forfeited' ? 0n : floor,
    });
  };

  append(input.order_type, owner, 0);
  if (direct !== null) append('direct', direct, 1);
  // BR-CALC-05/12：间推只在开关开启且直推层存在时产生；同人（异常数据）归平台并告警。
  if (input.indirect_enabled && direct !== null && indirect !== null) {
    if (indirect.user_id === owner.user_id || indirect.user_id === direct.user_id) {
      warnings.push('INDIRECT_SAME_PERSON');
    } else {
      append('indirect', indirect, 2);
    }
  }

  let userTotal = 0n;
  for (const share of shares) userTotal = addFen(userTotal, share.amount_fen);
  const platform_retain_fen = subFen(base_fen, userTotal, { nonNegative: true });

  return { reserve_fen, base_fen, shares, platform_retain_fen, warnings };
}

/** BR-CALC-20：调用同一个 splitCommission，淘礼金扣除为 0，返回本人份额 bigint。 */
export function quoteRebate(input: QuoteRebateInput): bigint {
  assertNonNegativeFen(input.n_quote_fen);
  const result = splitCommission({
    n_base_fen: input.n_quote_fen,
    reserve_bp: input.reserve_bp,
    tlj_deduct_fen: 0n,
    order_type: 'self',
    indirect_enabled: false,
    owner: { user_id: QUOTE_VIEWER, ratio_bp: input.r_own_bp, status: 'active' },
    direct: null,
    indirect: null,
  });
  const own = result.shares[0];
  if (own === undefined) throw new Error('quoteRebate: missing own share');
  return own.amount_fen;
}

/** 报价不涉及真实受益人，只用于从同一个 splitCommission 取本人份额。 */
const QUOTE_VIEWER = 'quote-viewer';

function assertNonNegativeFen(value: unknown): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new InvalidAmount('Amount must be non-negative bigint fen');
  }
}

function assertStatus(person: CommissionBeneficiary): void {
  const status: unknown = person.status;
  if (status !== 'active' && status !== 'forfeited') {
    throw new TypeError('Beneficiary status must be active or forfeited');
  }
}
