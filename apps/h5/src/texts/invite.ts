// 邀请好友页（F1-05a，路由 InviteShare）的文案。字典已有的键一律经 shared/texts.ts 的 t() 取契约字典
// contracts/texts.default.json：invite.share.*、invite.copy_code.done、invite.copy_link.done、
// invite.reward.tip_inviter、perm.photos.denied_forever、error.30413、error.10005、net.unavailable*、h5.*。
// 这里只登记 08 没有字典键的画板文案（design/specs/app-invite-share.md §3 末行）：规则摘要四条与活动规则五条
// 是设计起草，正文待负责人提供（06 Q-F4），由编排者登记补键；字典补上后改用字典。

/** 08 无键的按钮、标签与读屏名（画板 InviteShare-v2 / InviteShareReward / InviteShareUnavailable-v2）。 */
export const inviteTexts = {
  /** 邀请码卡顶部标签。 */
  codeLabel: '我的邀请码',
  /** 海报缩略图（点开全屏预览）的读屏名。 */
  posterPreview: '预览邀请海报',
  /** 暂不可邀请态的按钮。 */
  contactSupport: '联系客服',
} as const;

/**
 * 邀请规则卡的规则摘要（画板 InviteShare-v2，四条；活动无效时其后再加字典 invite.share.rule.no_reward）。
 */
export const inviteRuleSummary: readonly string[] = [
  '好友通过你的邀请链接注册，或注册后填写你的邀请码，符合条件即与你绑定。',
  '好友绑定后自己下单，你可以获得推广收益；结算前显示为预估，联盟结算后计入可提现余额。',
  '绑定后不能自行更改邀请人；好友注册时没有绑定的，可以在注册 7 天内、首次下单前补填一次。',
  '你能看到邀请人数和好友订单带来的收益金额与状态，看不到好友是谁、买了什么和订单号。',
];

/**
 * 奖励活动卡的活动规则摘要（画板 InviteShareReward，五条）。第二条的天数取配置 invite.eligibility_days，
 * 配置没给（或不是正整数）时整条不显示，不猜默认值。
 */
export const inviteRewardRules = {
  settle: '奖励在好友首单确认收货并结算后发放，发放后可在余额流水查看。',
  eligibility: (days: number): string =>
    `好友须在绑定后 ${days} 天内下单，之后下的订单不发放奖励。`,
  once: '每位好友只发放一次。',
  sameDevice: '你和好友使用同一台手机或同一网络的，不发放奖励。',
  limited: '活动奖励有限，发完即止。',
} as const;
