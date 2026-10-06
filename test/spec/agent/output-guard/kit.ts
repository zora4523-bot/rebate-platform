import { createOutputGuard } from '../../../../apps/api/src/modules/agent/guard/index.ts';
import type {
  GuardEmit,
  ReviewVerdict,
  SentenceReviewPort,
} from '../../../../apps/api/src/modules/agent/guard/index.ts';

// Public, synthetic vectors only; no vendor recordings or real credentials.
export const amounts = [
  '¥29',
  '￥ 29.9',
  '29元',
  '3块',
  '5毛',
  '2角',
  '8折',
  '85%',
  '85％',
  '二十九元',
  '两块',
  '返5',
  '省 10',
  '减3',
  '券5',
  '立减20',
  '到手 29',
  '满100减20',
];
export const quantities = ['24盒', '500ml', '3件', '第2个', '2026年', '八折'];
export const links = [
  'https://a.b/c',
  'http://x.net/p',
  'www.taobao.com',
  'taobao://item?id=1',
  'm.tb.cn/h.Ab',
  '例子.cn',
  'x.top/a',
  'x.cc',
  'x.vip',
  'custom+v1.2://item',
];
export const passcodes = [
  '￥AbCd1234Ef￥',
  '$AbCd1234$',
  '€AbCd1234€',
  '(AbCd1234)',
  '（AbCd1234）',
  '/AbCd1234/',
  '复制这段打开淘宝',
  '复制商品打开京东',
  '复制后打开拼多多',
];
export const folded = ['２９元', '８５％', 'ｈｔｔｐｓ：／／ｘ．ｃｏｍ', '￥ＡｂＣｄ１２３４￥'];
export const graderAmounts = [
  '29塊',
  '29圓',
  '29圆',
  '兩元',
  '貳元',
  '參元',
  '叄元',
  '陸元',
  '壹佰元',
  '兩塊',
  '兩圓',
  '壹萬圆',
  '貳億块',
];
export const riskParts = [
  ...amounts,
  ...links,
  ...passcodes,
  ...folded,
  ...graderAmounts,
  '£AbCd1234£',
  '¢AbCd1234¢',
  '₳AbCd1234₳',
  '复制',
  '打开淘宝',
  '。',
  '！',
  '？',
  '；',
  '!',
  '?',
  '\n',
  '.',
  ' ',
  '，',
  '推荐看看',
  '好'.repeat(59),
  '😀'.repeat(60),
  ...quantities,
];

export function textOf(emits: readonly GuardEmit[]): string {
  return emits.flatMap((emit) => (emit.kind === 'text' ? [emit.text] : [])).join('');
}

export function reviewScript(verdicts: readonly (ReviewVerdict | Error)[] = []) {
  const calls: string[] = [];
  const port: SentenceReviewPort = {
    async review(text) {
      const verdict = verdicts[calls.length] ?? 'pass';
      calls.push(text);
      if (verdict instanceof Error) throw verdict;
      return verdict;
    },
  };
  return { calls, port };
}

export async function runGuard(deltas: readonly string[]) {
  const review = reviewScript();
  const guard = createOutputGuard({ review: review.port });
  const emits: GuardEmit[] = [];
  for (const delta of deltas) emits.push(...(await guard.push(delta)));
  emits.push(...(await guard.end()));
  return { emits, text: textOf(emits), calls: review.calls, summary: guard.summary() };
}

// Cuts use UTF-16 offsets intentionally, including cuts inside a surrogate pair.
export function cutText(text: string, cuts: readonly number[]): string[] {
  const points = [...new Set([0, ...cuts.map((n) => n % (text.length + 1)), text.length])].sort(
    (a, b) => a - b,
  );
  return points.slice(1).map((end, index) => text.slice(points[index], end));
}
