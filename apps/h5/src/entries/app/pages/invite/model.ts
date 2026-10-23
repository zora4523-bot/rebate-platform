// 邀请好友页的配置解析与固定入口（不依赖 React，便于单测）。

/** 经桥 app.getConfig 读取的键（规格 §4：getConfig 经桥读取，只要 invite 段）。 */
export const CONFIG_KEYS = ['invite'];

/** cs.open 的 entry：只带调用页的 routes.json 名（BR-ID-33 细则），不带任何账号标识。 */
export const SUPPORT_ENTRY = 'InviteShare';

/**
 * 帮助文章（规格 §2：「完整规则」→ HelpArticleInviteRules，「活动规则」→ HelpArticleInviteReward）。
 * 契约 help_links 还没有这两项的键，先用固定的文章标识，由运营在帮助中心按此标识建文章；
 * 契约补键后改为读配置（已在输出里报编排者）。
 */
export const ARTICLE_INVITE_RULES = 'invite-rules';
export const ARTICLE_INVITE_REWARD = 'invite-reward';

/** 奖励活动（D36）：只有 reward_enabled 为真且金额为正整数分时才算有效。 */
export interface InviteReward {
  amountFen: bigint;
  /** 好友须在绑定后多少天内下单；配置没给或不合法为 null（该条规则不显示）。 */
  eligibilityDays: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * 解析 app.getConfig 的 values：reward_enabled 缺省或不是 true、金额缺失或不是正整数，都按活动无效（null）。
 */
export function parseInviteReward(values: unknown): InviteReward | null {
  const invite = record(record(values)?.['invite']);
  if (invite === null || invite['reward_enabled'] !== true) return null;
  const amount = positiveInteger(invite['reward_amount_fen']);
  if (amount === null) return null;
  return {
    amountFen: BigInt(amount),
    eligibilityDays: positiveInteger(invite['eligibility_days']),
  };
}
