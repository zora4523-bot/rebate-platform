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
  void input;
  throw new Error('NotImplemented: splitCommission');
}

/** BR-CALC-20：调用同一个 splitCommission，淘礼金扣除为 0，返回本人份额 bigint。 */
export function quoteRebate(input: QuoteRebateInput): bigint {
  void input;
  throw new Error('NotImplemented: quoteRebate');
}
