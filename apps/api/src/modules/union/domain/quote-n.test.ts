import { InvalidRatio } from '@couli/money';
import { expect, it } from 'vitest';
import { quoteN, type QuoteNInput } from './quote-n.ts';

const base = { finalPriceFen: 2990n, commissionRateBp: 2000n, techFeeBp: 1000n } as const;

it('[AC-B2-03b-UNIT#1] 淘宝京东两种订单类型同为 gross − fee（598 − 59 = 539）', () => {
  for (const platform of ['taobao', 'jd'] as const) {
    for (const orderType of ['self', 'share'] as const) {
      expect(quoteN({ ...base, platform, orderType })).toBe(539n);
    }
  }
});

it('[AC-B2-03b-UNIT#2] 拼多多先扣服务费再折算：自购一次 floor，分享只乘账号等级', () => {
  const pdd = { selfBuyFactorBp: 7500n, accountLevelFactorBp: 8000n };
  expect(quoteN({ ...base, platform: 'pdd', orderType: 'self', pdd })).toBe(323n);
  expect(quoteN({ ...base, platform: 'pdd', orderType: 'share', pdd })).toBe(431n);
  // floor(2 × 0.75 × 0.8) = 1; stepwise floor would give 0.
  const tiny = {
    platform: 'pdd',
    finalPriceFen: 2n,
    commissionRateBp: 10000n,
    techFeeBp: 0n,
    pdd,
  } as const;
  expect(quoteN({ ...tiny, orderType: 'self' })).toBe(1n);
});

it('[AC-B2-03b-UNIT#3] 拼多多缺系数一律 InvalidRatio，分享也要求两系数齐全', () => {
  const input: QuoteNInput = { ...base, platform: 'pdd', orderType: 'share' };
  expect(() => quoteN(input)).toThrow(InvalidRatio);
  expect(() =>
    quoteN({
      ...input,
      pdd: { accountLevelFactorBp: 10000n } as QuoteNInput['pdd'],
    } as QuoteNInput),
  ).toThrow(InvalidRatio);
});

it('[AC-B2-03b-UNIT#4] 未知订单类型与平台抛 TypeError', () => {
  expect(() =>
    quoteN({ ...base, platform: 'taobao', orderType: 'other' as QuoteNInput['orderType'] }),
  ).toThrow(TypeError);
  expect(() =>
    quoteN({ ...base, platform: 'vip' as QuoteNInput['platform'], orderType: 'self' }),
  ).toThrow(TypeError);
});
