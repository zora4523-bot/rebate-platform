// B1-07a spec review round 1 S1 (BR-PROD-03 parse row, TRADE-07): a URL on a union platform's web
// domain that is not a product or promo page (home page, store page) identifies no concrete product,
// so it gives 30132 ("search by product name"), not 30131 (platform or link unsupported). Whether
// the implementation first hands it to resolveLink is not constrained. Added by the orchestrator
// after the rule-test author's last attempt missed it (couli-runs/B1-07a/decision-orchestrator.md).
import { expect, it } from 'vitest';
import { cards, fixture } from './kit.ts';

it.each([
  ['jd', 'https://jd.example.test/'],
  ['taobao', 'https://tb.example.test/store'],
] as const)(
  '[AC-B1-07a-UNION-HOST-NON-PRODUCT] %s 联盟网页域名下的非商品页 %s 返回30132，不登记不出卡',
  async (platform, raw) => {
    const f = fixture();
    const results = await f.run(raw);
    expect(results).toEqual([
      { kind: 'error', hit: { platform, kind: 'url', raw }, error_code: 30132 },
    ]);
    expect(cards(results)).toEqual([]);
    expect(f.register).not.toHaveBeenCalled();
    expect(f.getItem).not.toHaveBeenCalled();
  },
);
