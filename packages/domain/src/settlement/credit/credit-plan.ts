import type { BuildVoucherParams } from '../../ledger/build-vouchers.ts';
import type { LedgerRole } from '../../ledger/ledger.ts';

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
  void input;
  throw new Error('NotImplemented: planInitialCredit');
}

/** BR-FUND-19 ⑤：只对未完成义务计 max(0, 重拆份额 - 净额)，同时检查两项。
 * positions 必须包含本单全部受益人净额；重复(user_id, role)抛RangeError。
 */
export function checkCreditInvariant(input: CreditInvariantInput): CreditInvariantResult {
  void input;
  throw new Error('NotImplemented: checkCreditInvariant');
}

/** BR-FUND-04 ⑫：先重验执行条件与整单⑤，再按当前状态决定补记/暂缓/没收。
 * 跳过时 remaining_fen=0、不处置义务、不输出凭证；⑤不成立另返回 alert=true。
 * 金额为0仍按正常/失效状态关闭义务；冻结/申诉则保持未完成。
 * 待执行的未完成义务须恰好匹配一个 positions 条目且 has_open_obligation=true，
 * 不一致是调用方输入错误，抛 RangeError，不能产生资金计划。
 */
export function planBeneficiaryCredit(input: BeneficiaryCreditInput): BeneficiaryCreditPlan {
  void input;
  throw new Error('NotImplemented: planBeneficiaryCredit');
}
