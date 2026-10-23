// B1-09b：归因流水线第 ③ 步黑名单的纯判定（BR-ATTR-26）。不读库、不读时钟、不读配置；名单命中由 risk 的
// 订单侧名单端口给出（B1-09a），尾号维度开关由调用方读好传入。
// - 尾号维度（order_no_suffix）开关关闭：命中只记 risk_hits（manual_review），不改返利状态、不发事件。
// - 其余命中按 rebate_status：UNATTRIBUTED / ESTIMATED / WAITING → void（经返利端口 BLACKLIST_HIT，R6）；
//   CREDITED → after_credit（入队 order.blacklist_hit_after_credit，进人工复核）；VOID / CLAWED_BACK → 不处理。
// - 不改 user_id、buy_type。

/** risk 订单侧名单的两种维度（BR-ATTR-26 ① ②）。 */
export type BlacklistDimension = 'order_no_suffix' | 'channel';

/** 写进 risk_hits 的处置（BR-ATTR-26：manual_review / void_commission）。 */
export type BlacklistRiskAction = 'manual_review' | 'void_commission';

/**
 * 订单侧处置：none = 不改返利状态、不发事件；void = 经返利端口 BLACKLIST_HIT（BR-FUND-01 R6）；
 * after_credit = 不自动扣回，入队 order.blacklist_hit_after_credit 进人工复核。
 */
export type BlacklistDisposition = 'none' | 'void' | 'after_credit';

export interface BlacklistMatchInput {
  readonly dimension: BlacklistDimension;
  readonly value: string;
}

export interface PlanBlacklistInput {
  /** risk 名单端口本次返回的全部命中（两种维度）。 */
  readonly matches: readonly BlacklistMatchInput[];
  /** 判定时订单的返利状态。 */
  readonly rebate_status: string;
  /** attr.blacklist.order_suffix_void_enabled（默认 false）。 */
  readonly suffix_void_enabled: boolean;
}

export interface BlacklistHitPlan {
  readonly dimension: BlacklistDimension;
  readonly value: string;
  readonly risk_action: BlacklistRiskAction;
}

export interface BlacklistPlan {
  readonly disposition: BlacklistDisposition;
  /** 要写进 risk_hits 的命中（每条经 risk 端口 recordHit）。 */
  readonly hits: readonly BlacklistHitPlan[];
}

/** R6 的来源状态（BR-ATTR-26「rebate_status ∈ {UNATTRIBUTED, ESTIMATED, WAITING}」）。 */
const PRECREDIT: ReadonlySet<string> = new Set(['UNATTRIBUTED', 'ESTIMATED', 'WAITING']);
/** 已为终态，命中不处理，也不写 risk_hits。 */
const SETTLED_OFF: ReadonlySet<string> = new Set(['VOID', 'CLAWED_BACK']);
const CREDITED = 'CREDITED';

const NO_PLAN: BlacklistPlan = Object.freeze({ disposition: 'none', hits: Object.freeze([]) });

/** 该命中是否按「命中后的处理」执行：渠道维度总是；尾号维度只在开关打开后。 */
function actionable(match: BlacklistMatchInput, suffixVoidEnabled: boolean): boolean {
  return match.dimension === 'channel' || suffixVoidEnabled;
}

export function planBlacklistHit(input: PlanBlacklistInput): BlacklistPlan {
  const status = input.rebate_status;
  if (input.matches.length === 0 || SETTLED_OFF.has(status)) return NO_PLAN;
  const precredit = PRECREDIT.has(status);
  if (!precredit && status !== CREDITED) {
    // BR-FUND-01 只有六种返利状态；别的值是数据损坏，不猜处置。
    throw new Error('BLACKLIST_REBATE_STATUS_INVALID: rebate_status 不在 BR-FUND-01 的六种之内');
  }
  // 同一维度同一值只记一条（risk 端口按 (订单, 值) 也只写一次）。
  const seen = new Set<string>();
  const hits: BlacklistHitPlan[] = [];
  let act = false;
  for (const match of input.matches) {
    const key = `${match.dimension}\0${match.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const on = actionable(match, input.suffix_void_enabled);
    act = act || on;
    hits.push({
      dimension: match.dimension,
      value: match.value,
      // 未入账且按命中处理 → void_commission；已入账不自动扣回、未启用的尾号维度 → manual_review。
      risk_action: on && precredit ? 'void_commission' : 'manual_review',
    });
  }
  const disposition: BlacklistDisposition = !act ? 'none' : precredit ? 'void' : 'after_credit';
  return { disposition, hits };
}
