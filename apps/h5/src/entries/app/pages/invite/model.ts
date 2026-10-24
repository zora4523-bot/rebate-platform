import type { BridgeMethods } from '@couli/bridge-sdk';

// 邀请好友页的配置解析与固定入口（不依赖 React，便于单测）。

/** 经桥 app.getConfig 读取的键（规格 §4：getConfig 经桥读取）：invite 段与帮助文章入口 help_links。 */
export const CONFIG_KEYS = ['invite', 'help_links'];

/** cs.open 的 entry：只带调用页的 routes.json 名（BR-ID-33 细则），不带任何账号标识。 */
export const SUPPORT_ENTRY = 'InviteShare';

/** nav.open 的参数：help_links 的跳转目标 {route, params} 原样交给桥。 */
export type HelpTarget = BridgeMethods['nav.open']['params'];

/**
 * 两张卡的帮助文章入口（契约 CT-16n，D10-252）：help_links.invite_rules →【完整规则】，
 * help_links.invite_reward_rules →【活动规则】。键未配置（或配置读取失败）为 null，对应入口不显示。
 */
export interface InviteLinks {
  rules: HelpTarget | null;
  rewardRules: HelpTarget | null;
}

export const NO_LINKS: InviteLinks = { rules: null, rewardRules: null };

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

/** 只认 {route, params} 对象（route 为非空字符串、params 为对象），其余按未配置。 */
function helpTarget(value: unknown): HelpTarget | null {
  const link = record(value);
  if (link === null || typeof link['route'] !== 'string' || link['route'] === '') return null;
  if (record(link['params']) === null) return null;
  return link as unknown as HelpTarget;
}

/** 解析 app.getConfig 的 values 里的 help_links：缺失、不是对象或键缺失都按该入口不显示。 */
export function parseInviteLinks(values: unknown): InviteLinks {
  const links = record(record(values)?.['help_links']) ?? {};
  return {
    rules: helpTarget(links['invite_rules']),
    rewardRules: helpTarget(links['invite_reward_rules']),
  };
}
