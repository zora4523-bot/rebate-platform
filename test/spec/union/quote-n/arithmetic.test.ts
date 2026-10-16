import { expect, it } from 'vitest';
import { quoteN, type QuoteNInput } from '../../../../apps/api/src/modules/union/index.ts';

// Task-local AC labels. Only BR-CALC-17 / BR-CALC-20 and task §9 are in scope.
// PDD fee ordering is undecided: every PDD case deliberately uses techFeeBp = 0.
// Upstream rate selection, order-side N, reserve, split and display belong to other tasks.
const standardCases = [
  { platform: 'taobao', orderType: 'self' },
  { platform: 'taobao', orderType: 'share' },
  { platform: 'jd', orderType: 'self' },
  { platform: 'jd', orderType: 'share' },
] as const;

it.each(standardCases)(
  '[AC-B2-03b#1][BR-CALC-20] $platform $orderType：2990 × 2000bp，扣 59 分服务费得 539',
  ({ platform, orderType }) => {
    expect(
      quoteN({
        platform,
        orderType,
        finalPriceFen: 2990n,
        commissionRateBp: 2000n,
        techFeeBp: 1000n,
      }),
    ).toBe(539n);
  },
);

it.each(standardCases)(
  '[AC-B2-03b#2][BR-CALC-20] $platform $orderType：gross 与 fee 分别 floor，不合并净率',
  ({ platform, orderType }) => {
    // gross=floor(3×5000/10000)=1; fee=floor(1×5000/10000)=0; N=1.
    // Flooring the combined net rate would incorrectly give 0.
    expect(
      quoteN({ platform, orderType, finalPriceFen: 3n, commissionRateBp: 5000n, techFeeBp: 5000n }),
    ).toBe(1n);
    // The gross fraction must be discarded before computing the fee: gross=1, fee=0.
    expect(
      quoteN({
        platform,
        orderType,
        finalPriceFen: 19n,
        commissionRateBp: 1000n,
        techFeeBp: 6000n,
      }),
    ).toBe(1n);
  },
);

it.each(standardCases)(
  '[AC-B2-03b#3][BR-CALC-20] $platform $orderType：零值、比例端点和不足一分',
  ({ platform, orderType }) => {
    const vectors = [
      { finalPriceFen: 0n, commissionRateBp: 10000n, techFeeBp: 10000n, expected: 0n },
      { finalPriceFen: 2990n, commissionRateBp: 0n, techFeeBp: 1000n, expected: 0n },
      { finalPriceFen: 2990n, commissionRateBp: 2000n, techFeeBp: 0n, expected: 598n },
      { finalPriceFen: 2990n, commissionRateBp: 2000n, techFeeBp: 10000n, expected: 0n },
      { finalPriceFen: 2990n, commissionRateBp: 10000n, techFeeBp: 0n, expected: 2990n },
      { finalPriceFen: 1n, commissionRateBp: 9999n, techFeeBp: 0n, expected: 0n },
      { finalPriceFen: 10000n, commissionRateBp: 1n, techFeeBp: 9999n, expected: 1n },
    ];
    for (const { expected, ...amounts } of vectors) {
      expect(quoteN({ platform, orderType, ...amounts })).toBe(expected);
    }
  },
);

it.each(standardCases)(
  '[AC-B2-03b#4][BR-CALC-17] $platform $orderType 忽略多余的拼多多系数',
  ({ platform, orderType }) => {
    const input = {
      platform,
      orderType,
      finalPriceFen: 2990n,
      commissionRateBp: 2000n,
      techFeeBp: 1000n,
    };
    expect(quoteN({ ...input, pdd: { selfBuyFactorBp: 0n, accountLevelFactorBp: 0n } })).toBe(539n);
    expect(quoteN({ ...input, pdd: { selfBuyFactorBp: -1n, accountLevelFactorBp: 10001n } })).toBe(
      539n,
    );
  },
);

it.each(standardCases)(
  '[AC-B2-03b#5][BR-CALC-20] $platform $orderType：超过安全 number 的金额仍逐分精确',
  ({ platform, orderType }) => {
    expect(
      quoteN({
        platform,
        orderType,
        finalPriceFen: 9007199254740993n,
        commissionRateBp: 10000n,
        techFeeBp: 0n,
      }),
    ).toBe(9007199254740993n);
    // gross=9007199254740993; fee=900719925474099.
    expect(
      quoteN({
        platform,
        orderType,
        finalPriceFen: 9007199254740993n,
        commissionRateBp: 10000n,
        techFeeBp: 1000n,
      }),
    ).toBe(8106479329266894n);
    expect(
      quoteN({
        platform,
        orderType,
        finalPriceFen: 9223372036854775807n,
        commissionRateBp: 10000n,
        techFeeBp: 10000n,
      }),
    ).toBe(0n);
  },
);

it.each([
  { label: '原例自购', amount: 400n, self: 7500n, level: 10000n, own: 300n, share: 400n },
  { label: '原例两系数均非一', amount: 333n, self: 7500n, level: 8000n, own: 199n, share: 266n },
  // Sequential flooring in either order incorrectly yields 0 instead of 1.
  { label: '分步 floor 反例', amount: 2n, self: 7500n, level: 8000n, own: 1n, share: 1n },
  { label: '系数互换反例', amount: 2n, self: 8000n, level: 7500n, own: 1n, share: 1n },
  { label: '不提前截断系数乘积', amount: 100000000n, self: 1n, level: 1n, own: 1n, share: 10000n },
  { label: '零金额', amount: 0n, self: 7500n, level: 8000n, own: 0n, share: 0n },
  { label: '自购系数零不影响分享', amount: 333n, self: 0n, level: 8000n, own: 0n, share: 266n },
  { label: '账号等级系数零', amount: 333n, self: 7500n, level: 0n, own: 0n, share: 0n },
  { label: '系数均为上界', amount: 333n, self: 10000n, level: 10000n, own: 333n, share: 333n },
  { label: '不足一分', amount: 1n, self: 9999n, level: 9999n, own: 0n, share: 0n },
  {
    label: '超安全整数精度',
    amount: 9007199254740993n,
    self: 7500n,
    level: 8000n,
    own: 5404319552844595n,
    share: 7205759403792794n,
  },
])('[AC-B2-03b#6][BR-CALC-17] 拼多多 $label', ({ amount, self, level, own, share }) => {
  const input: QuoteNInput = {
    platform: 'pdd',
    orderType: 'self',
    finalPriceFen: amount,
    commissionRateBp: 10000n,
    techFeeBp: 0n,
    pdd: { selfBuyFactorBp: self, accountLevelFactorBp: level },
  };
  expect(quoteN(input)).toBe(own);
  expect(quoteN({ ...input, orderType: 'share' })).toBe(share);
});

it('[AC-B2-03b#7][BR-CALC-17][BR-CALC-20] 拼多多先由价格和费率求 gross，再折算系数', () => {
  // floor(3×5000/10000)=1; self=floor(1×7500×8000/10^8)=0; share=0.
  // Combining price, rate and factors into one floor incorrectly gives 1 for share.
  const input: QuoteNInput = {
    platform: 'pdd',
    orderType: 'self',
    finalPriceFen: 3n,
    commissionRateBp: 5000n,
    techFeeBp: 0n,
    pdd: { selfBuyFactorBp: 7500n, accountLevelFactorBp: 8000n },
  };
  expect(quoteN(input)).toBe(0n);
  expect(quoteN({ ...input, orderType: 'share' })).toBe(0n);
  // Nontrivial rate ensures price is not mistaken for the commission amount.
  expect(quoteN({ ...input, finalPriceFen: 2990n, commissionRateBp: 2000n })).toBe(358n);
  expect(
    quoteN({ ...input, orderType: 'share', finalPriceFen: 2990n, commissionRateBp: 2000n }),
  ).toBe(478n);
});
