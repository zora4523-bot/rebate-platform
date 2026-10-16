export interface RuleVersionRow {
  readonly platform: string;
  readonly level: 'L1' | 'L2' | 'L3';
  readonly order_type: 'self' | 'share';
  readonly r_own_bp: bigint;
  readonly r_direct_bp: bigint;
  readonly r_indirect_bp: bigint;
}

export interface RuleVersionReserve {
  readonly platform: string;
  readonly reserve_bp: bigint;
}

export interface RuleVersionDraft {
  readonly indirect_enabled: boolean;
  /** ISO 8601 +08:00；比较精度到秒。 */
  readonly effective_from: string;
  readonly rules: readonly RuleVersionRow[];
  readonly reserves: readonly RuleVersionReserve[];
}

export interface ValidateRuleVersionInput {
  readonly draft: RuleVersionDraft;
  /** 调用方传入 commission.platforms，不能硬编码当前平台清单。 */
  readonly platforms: readonly string[];
  /** 调用方经 Clock 取得的 ISO 8601 +08:00 时刻。 */
  readonly publish_at: string;
  /** 调用方只传已发布且未撤销版本；包含尚未生效版本，顺序不限。 */
  readonly published_effective_froms: readonly string[];
  /** MVP 不传时为 0；非零值也须计入每组上限。 */
  readonly activity_bonus_bp?: bigint;
}

/** 纯函数的内部诊断标识，不是 HTTP 错误码；接口映射由后续契约任务定义。 */
export type RuleVersionValidationCode =
  | 'MISSING_RULE'
  | 'DUPLICATE_RULE'
  | 'UNKNOWN_PLATFORM'
  | 'MISSING_RESERVE'
  | 'DUPLICATE_RESERVE'
  | 'RATIO_OUT_OF_RANGE'
  | 'RESERVE_OUT_OF_RANGE'
  | 'ACTIVITY_BONUS_OUT_OF_RANGE'
  | 'TOTAL_RATIO_EXCEEDED'
  | 'INDIRECT_DISABLED'
  | 'INVALID_EFFECTIVE_FROM'
  | 'EFFECTIVE_BEFORE_PUBLISH'
  | 'EFFECTIVE_NOT_INCREASING';

export interface RuleVersionValidationError {
  readonly code: RuleVersionValidationCode;
  readonly platform?: string;
  readonly level?: RuleVersionRow['level'];
  readonly order_type?: RuleVersionRow['order_type'];
  /** 可定位的原因说明；单项比例错误须包含字段名，不约定文案。 */
  readonly detail: string;
}

export type ValidateRuleVersionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly RuleVersionValidationError[] };

/**
 * BR-CALC-05/06/07/11：校验完整草稿，不读取时钟、不做 I/O、不改输入。
 * 返回全部拒绝原因，不抛错、不截断；相同输入的错误内容及顺序稳定。
 * 行错误携带 platform/level/order_type，预留错误携带 platform，合计错误
 * 携带 platform/order_type。时间字符串须合法且带 +08:00，不归一化非法日期。
 */
export function validateRuleVersion(input: ValidateRuleVersionInput): ValidateRuleVersionResult {
  void input;
  throw new Error('NotImplemented: validateRuleVersion');
}
