// B1-15i: the expected texts, written out from the spec (not taken from the implementation).
// BR-TEXT-23 细则模板表 DELETION_PROGRESS (three variants, verbatim) and BR-TEXT-09 细则标题表
// inbox.title.DELETION_PROGRESS (contracts/texts.default.json).

export const CODE = 'DELETION_PROGRESS';
export const TITLE = '注销进度';
export const CANCELLED_BODY = '已撤回注销申请，账号恢复正常使用。';
export const requestedBody = (deadline: string) =>
  `注销申请已提交，${deadline} 前可在「设置 → 账号与安全」撤回。`;
export const negativeBody = (amount: string) =>
  `你的账户有待扣回金额 ${amount}，注销申请已撤销。后续返利抵扣回正后可重新申请，如有疑问请联系客服。`;

export type Variant = 'requested' | 'cancelled' | 'cancelled_negative';

/** Brief §9.2 #1: the notify_logs dedupe key of one request and variant. */
export const dedupeKey = (requestId: string, variant: Variant) => `${requestId}:${CODE}:${variant}`;

/**
 * BR-TEXT-10 App amounts (formatYuan): yuan, at most two decimals, trailing zeros dropped, no
 * grouping. Written out per case, never computed from the implementation.
 */
export const AMOUNTS: [fen: bigint, text: string][] = [
  [1n, '¥0.01'],
  [10n, '¥0.1'],
  [100n, '¥1'],
  [120n, '¥1.2'],
  [1234n, '¥12.34'],
  [123_450n, '¥1234.5'],
  [9_007_199_254_740_993n, '¥90071992547409.93'],
];
