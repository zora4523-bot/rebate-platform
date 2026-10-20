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

/** 缺佣金只返回判定，不做 S12 的待处理表写入或告警 I/O。 */
export function selectClawbackCommission(input: ClawbackCommissionInput): ClawbackCommissionResult {
  void input;
  throw new Error('NotImplemented: selectClawbackCommission');
}

/**
 * BR-CALC-09/23、BR-FUND-08/09、04⑫：纯计算建议，不写余额、不迁移状态。
 * 首版淘礼金未接入，tlj_deduct_fen 恒 0（BR-CALC-02 细则）。金额运算只用 @couli/money。
 * 输入为 CREDITED 单、快照比例与锁内当前净额/状态；恢复后的身份以当前 status 传入。
 * approval 表示候选预览，不能直接落账；审批/seq/时序校验由调用方负责，批准时重新调用。
 * 义务关闭由调用方同事务关联实际凭证；平台零凭证时关联 seq / rights_event_id。
 * 不按 available 余额限扣，不触碰 frozen；幂等、锁与 app_id 隔离由调用方负责。
 */
export function planCommissionAdjustment(input: AdjustmentInput): AdjustmentPlan {
  void input;
  throw new Error('NotImplemented: planCommissionAdjustment');
}

/** BR-FUND-08：期望净影响 = max(N_new,0) - booked_n - (待补记后 - 待补记前)。 */
export function checkAdjustmentReceivable(input: AdjustmentReceivableInput): {
  readonly valid: boolean;
  readonly expected_delta_fen: bigint;
} {
  void input;
  throw new Error('NotImplemented: checkAdjustmentReceivable');
}
