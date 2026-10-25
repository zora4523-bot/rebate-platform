// B2-15f: the pure part of the manual settlement of a needs_manual pay order (08 BR-PAY-05 ③:
// 【立即查询】后按渠道结果结束——已支付 PO2；已关闭，或符合 ② 的不存在条件 PO3; contract
// resolveAdminPayOrder, AdminPayChannelResult). No clock, no database: the query answer and whether
// the BR-PAY-05 ② condition holds come in as arguments.
// Also compiled by the `test` project: erasable syntax only.

/** A channel query answer as the settlement reads it (no channel-side user identifier). */
export type ResolveQueryAnswer =
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'ok';
      readonly state: 'paid' | 'not_paid' | 'closed' | 'not_exist';
      /** The channel's own status code as received (WeChat trade_state, Alipay trade_status). */
      readonly channelState: string | null;
      readonly channelTradeNo: string | null;
    };

/**
 * What the answer allows: judge_paid → the checks of BR-PAY-04, then PO2; close → PO3 on the
 * basis named; keep → nothing moves (unknown, not paid yet, or «not exist» before
 * expire_at + pay.close_grace_minutes: 「单据不存在」不等于已关闭).
 */
export type ResolvePlan =
  | { readonly kind: 'judge_paid' }
  | { readonly kind: 'close'; readonly basis: 'channel_closed' | 'not_exist_after_grace' }
  | { readonly kind: 'keep' };

export function resolvePlanOf(answer: ResolveQueryAnswer, notExistMayClose: boolean): ResolvePlan {
  if (answer.kind === 'unknown') return { kind: 'keep' };
  switch (answer.state) {
    case 'paid':
      return { kind: 'judge_paid' };
    case 'closed':
      return { kind: 'close', basis: 'channel_closed' };
    case 'not_exist':
      return notExistMayClose
        ? { kind: 'close', basis: 'not_exist_after_grace' }
        : { kind: 'keep' };
    case 'not_paid':
      return { kind: 'keep' };
  }
}

/** contract AdminPayChannelResult.state. */
export type ChannelResultState = 'paid' | 'closed' | 'not_exist' | 'unknown';

export interface ChannelResultSummary {
  readonly state: ChannelResultState;
  readonly channelState: string | null;
  readonly channelTradeNo: string | null;
}

/**
 * How the server read the answer (contract AdminPayChannelResult): paid only when the order was
 * settled by it (a paid answer that failed the checks of BR-PAY-04 reads unknown); closed and
 * not_exist as answered (not_exist whether or not it closed the order); unknown for an unknown
 * answer and for «not paid yet». The channel's own state and trade number are passed through as
 * received; an unknown answer carries neither.
 */
export function channelResultOf(
  answer: ResolveQueryAnswer,
  settled: boolean,
): ChannelResultSummary {
  if (answer.kind === 'unknown') {
    return { state: 'unknown', channelState: null, channelTradeNo: null };
  }
  const passed = { channelState: answer.channelState, channelTradeNo: answer.channelTradeNo };
  switch (answer.state) {
    case 'paid':
      return { state: settled ? 'paid' : 'unknown', ...passed };
    case 'closed':
      return { state: 'closed', ...passed };
    case 'not_exist':
      return { state: 'not_exist', ...passed };
    case 'not_paid':
      return { state: 'unknown', ...passed };
  }
}
