// B3-05f · BR-AI-01 细则「判定顺序」②: the server-side check of the model's classification.
// The model labels the message; the server reads the user's own text and only ever raises the
// label along the fixed priority 本人查询 > page_guide > rule_qa (never lowers it). Whether the
// text contains 「我」/「我的」 is not a criterion on its own (R2-01): it only cancels a generic
// marker such as 「一般」 when it points at the user's own data.

/** Regular-expression sources (compiled with the `u` flag), applied to the user's text with
 * white space and trailing punctuation removed. Returned fresh by a function, not a constant. */
export interface IntentTextPatterns {
  /** A specific order: 那单, 订单号, a long digit run … → order_query. */
  readonly orderExplicit: string;
  /** A purchase or an order that becomes order_query only together with `progress`. */
  readonly orderSoft: string;
  /** Account amounts and withdrawals (not 返利, which may be an order's rebate). */
  readonly earningsNoun: string;
  /** Rebate wording that, with `progress`, asks about the user's own data. */
  readonly rebateNoun: string;
  /** Asking for an amount, a time or a state (personal data together with a noun). */
  readonly progress: string;
  /** Asking whether a rebate arrived; personal on its own (那返了吗). */
  readonly rebateProgress: string;
  /** Asking about withdrawal progress → topic withdrawal_progress. */
  readonly withdrawalProgress: string;
  /** Generic wording (一般 / 规则 / 多久 / 怎么算 …) → rule_qa unless `selfPointer`. */
  readonly generic: string;
  /** Points at the user's own data; cancels `generic`. */
  readonly selfPointer: string;
  /** Asking where a page is. 到哪 (progress) is not a location. */
  readonly location: string;
  /** Asking how to start an operation (怎么提现) → an entry page. */
  readonly howTo: string;
}

export function intentTextPatterns(): IntentTextPatterns {
  return {
    orderExplicit:
      '那单|这单|那笔|这笔|上一单|那个订单|这个订单|订单号|单号|(?<!\\d)\\d{10,}(?!\\d)',
    orderSoft: '买的|购买的|下的单|下单的|订单',
    earningsNoun: '余额|收益|可提|提现|多少钱|钱',
    rebateNoun: '返利|返现',
    progress: '多少|几块|几元|到哪|进度|到账|结算|返了|返没返|没返|还没|什么时候|啥时候|多会儿|呢$',
    rebateProgress: '返了[吗没么]?|返没返|没返|还没返|到账了[吗没么]?',
    withdrawalProgress: '提现.*(?:到哪|进度|到账|审核|什么时候|啥时候|还没|怎么样)',
    generic:
      '一般|通常|规则|多久|几天|怎么算|如何计算|最低|最少|最高|最多|上限|下限|门槛|规定|标准|手续费',
    selfPointer:
      '我(?:的|那|这)?(?:返利|收益|余额|钱|提现|订单|那单|这单)|我(?:还|现在)?(?:有|能提|可以提|可提)',
    location: '在哪|(?<!到)哪里|(?<!到)哪儿|(?<!到)哪(?:看|找|查)|入口|从哪',
    howTo: '(?:怎么|如何|怎样)(?:才能|可以|能)?(?:提现|查看|看|找|打开|进入|进|邀请|授权|绑定)',
  };
}

/** Degrade targets and text hints named by BR-AI-01 细则「判定顺序」④ / 「页面引导」 examples. The
 * candidate list itself is never read from here: every route still passes configuration ∩
 * contract agent_guide before a card is sent. */
export interface GuideTargets {
  readonly wallet: string;
  readonly withdrawRecords: string;
  readonly orderList: string;
}

export function guideTargets(): GuideTargets {
  return { wallet: 'Wallet', withdrawRecords: 'WithdrawRecords', orderList: 'OrderList' };
}

export type TextClass =
  /** Mentions a specific order or purchase → order_query. */
  | { readonly kind: 'order' }
  /** Account amounts / withdrawal progress → earnings_query. */
  | { readonly kind: 'earnings'; readonly withdrawal: boolean }
  /** Personal data without a subject (那返了吗, 我的返利…): order or earnings from context. */
  | { readonly kind: 'personal'; readonly withdrawal: boolean }
  /** Asks where a page is or how to start an operation; route is a hint or null. */
  | { readonly kind: 'page'; readonly route: string | null }
  /** Generic rule wording, not pointing at the user's data. */
  | { readonly kind: 'rule' }
  | { readonly kind: 'unknown' };

export interface TextClassifier {
  classify(text: string): TextClass;
}

export function createTextClassifier(
  patterns: IntentTextPatterns,
  targets: GuideTargets,
): TextClassifier {
  const re = (source: string) => new RegExp(source, 'u');
  const orderExplicit = re(patterns.orderExplicit);
  const orderSoft = re(patterns.orderSoft);
  const earningsNoun = re(patterns.earningsNoun);
  const rebateNoun = re(patterns.rebateNoun);
  const progress = re(patterns.progress);
  const rebateProgress = re(patterns.rebateProgress);
  const withdrawalProgress = re(patterns.withdrawalProgress);
  const generic = re(patterns.generic);
  const selfPointer = re(patterns.selfPointer);
  const location = re(patterns.location);
  const howTo = re(patterns.howTo);
  const routeHint = (text: string): string | null => {
    if (/提现(?:记录|明细|历史)/u.test(text)) return targets.withdrawRecords;
    if (/钱包|余额|提现/u.test(text)) return targets.wallet;
    if (/订单/u.test(text)) return targets.orderList;
    return null;
  };
  return {
    classify(input) {
      const text = input.replace(/\s+/gu, '').replace(/[?？!！。.,，~～…]+$/u, '');
      if (text === '') return { kind: 'unknown' };
      if (orderExplicit.test(text)) return { kind: 'order' };
      const isGeneric = generic.test(text) && !selfPointer.test(text);
      const asksProgress = progress.test(text);
      const withdrawal = withdrawalProgress.test(text);
      if (!isGeneric) {
        if (orderSoft.test(text) && (asksProgress || rebateProgress.test(text))) {
          return { kind: 'order' };
        }
        if (earningsNoun.test(text) && asksProgress) return { kind: 'earnings', withdrawal };
        if (rebateProgress.test(text) || (rebateNoun.test(text) && asksProgress)) {
          return { kind: 'personal', withdrawal };
        }
      }
      if (location.test(text) || howTo.test(text)) return { kind: 'page', route: routeHint(text) };
      if (isGeneric) return { kind: 'rule' };
      return { kind: 'unknown' };
    },
  };
}
