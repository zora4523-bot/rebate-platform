import { InvalidRatio } from '@couli/money';
import { expect, it } from 'vitest';
import { quoteN, type QuoteNInput } from '../../../../apps/api/src/modules/union/index.ts';

// BR-CALC-17 已明确方案 A：先按 BR-CALC-20 扣技术服务费，再折算拼多多系数。
// 本文件补充既有零服务费测试；期望值独立手算，不调用 money 函数生成。
const cases = [
  {
    label: '默认系数下先扣费',
    finalPriceFen: 2990n,
    commissionRateBp: 2000n,
    techFeeBp: 1000n,
    selfBuyFactorBp: 7500n,
    accountLevelFactorBp: 10000n,
    // gross=598，fee=59，N=539；self=floor(539×0.75)=404，share=539。
    self: 404n,
    share: 539n,
  },
  {
    label: '账号等级系数 8000',
    finalPriceFen: 2990n,
    commissionRateBp: 2000n,
    techFeeBp: 1000n,
    selfBuyFactorBp: 7500n,
    accountLevelFactorBp: 8000n,
    // gross=598，fee=59，N=539；self=floor(323.4)=323，share=floor(431.2)=431。
    self: 323n,
    share: 431n,
  },
  {
    label: '方案 A 与先折算后扣费的方案 B 不同',
    finalPriceFen: 2n,
    commissionRateBp: 10000n,
    techFeeBp: 5000n,
    selfBuyFactorBp: 7500n,
    accountLevelFactorBp: 8000n,
    // A：gross=2，fee=1，N=1；self=floor(0.6)=0，share=floor(0.8)=0。
    // B：先折算 gross，自购 floor(1.2)=1、分享 floor(1.6)=1；
    // 再扣 floor(1×0.5)=0 的服务费，两者均错误地返回 1。
    self: 0n,
    share: 0n,
  },
  {
    label: '扣费后两系数一次乘完再 floor',
    finalPriceFen: 3n,
    commissionRateBp: 10000n,
    techFeeBp: 5000n,
    selfBuyFactorBp: 7500n,
    accountLevelFactorBp: 8000n,
    // gross=3，fee=1，N=2；self=floor(1.2)=1，share=floor(1.6)=1。
    // 自购分步 floor：floor(floor(2×0.75)×0.8)=0，错误；交换系数顺序也为 0。
    self: 1n,
    share: 1n,
  },
  {
    label: 'gross 与 fee 分别 floor',
    finalPriceFen: 19n,
    commissionRateBp: 1000n,
    techFeeBp: 6000n,
    selfBuyFactorBp: 10000n,
    accountLevelFactorBp: 10000n,
    // gross=floor(1.9)=1，fee=floor(0.6)=0，N=1；系数均为 1，两者得 1。
    // 从未截断的 1.9 算 fee 会扣 1 分；合并净率 floor(19×0.1×0.4) 也会错得 0。
    self: 1n,
    share: 1n,
  },
  {
    label: '自购系数零不影响分享扣费后的佣金',
    finalPriceFen: 333n,
    commissionRateBp: 10000n,
    techFeeBp: 1000n,
    selfBuyFactorBp: 0n,
    accountLevelFactorBp: 8000n,
    // gross=333，fee=33，N=300；self=0，share=floor(300×0.8)=240。
    self: 0n,
    share: 240n,
  },
  {
    label: '服务费率上界扣尽 gross',
    finalPriceFen: 2990n,
    commissionRateBp: 2000n,
    techFeeBp: 10000n,
    selfBuyFactorBp: 7500n,
    accountLevelFactorBp: 8000n,
    // gross=598，fee=598，N=0；自购与分享均为 0。
    self: 0n,
    share: 0n,
  },
];

it.each(cases)('[AC-B2-03b#17][BR-CALC-17][BR-CALC-20] 拼多多自购：$label', (row) => {
  expect(
    quoteN({
      platform: 'pdd',
      orderType: 'self',
      finalPriceFen: row.finalPriceFen,
      commissionRateBp: row.commissionRateBp,
      techFeeBp: row.techFeeBp,
      pdd: {
        selfBuyFactorBp: row.selfBuyFactorBp,
        accountLevelFactorBp: row.accountLevelFactorBp,
      },
    }),
  ).toBe(row.self);
});

it.each(cases)('[AC-B2-03b#18][BR-CALC-17][BR-CALC-20] 拼多多分享：$label', (row) => {
  expect(
    quoteN({
      platform: 'pdd',
      orderType: 'share',
      finalPriceFen: row.finalPriceFen,
      commissionRateBp: row.commissionRateBp,
      techFeeBp: row.techFeeBp,
      pdd: {
        selfBuyFactorBp: row.selfBuyFactorBp,
        accountLevelFactorBp: row.accountLevelFactorBp,
      },
    }),
  ).toBe(row.share);
});

const invalidFees: { label: string; value: unknown }[] = [
  { label: '负比例', value: -1n },
  { label: '超过上界', value: 10001n },
  { label: 'number 零', value: 0 },
  { label: 'number 整数', value: 1000 },
  { label: 'number 小数', value: 0.5 },
  { label: 'NaN', value: NaN },
  { label: 'Infinity', value: Infinity },
  { label: '字符串', value: '1000' },
  { label: 'null', value: null },
  { label: 'undefined', value: undefined },
  { label: '布尔值', value: false },
  { label: '对象', value: {} },
  { label: '数组', value: [1000n] },
  { label: 'symbol', value: Symbol('invalid-fee') },
  { label: '可强转对象', value: { valueOf: () => 1000n } },
];

it.each(invalidFees)(
  '[AC-B2-03b#19][BR-CALC-20] 拼多多两订单类型：$label 服务费率抛 InvalidRatio，零值不能绕过',
  ({ value }) => {
    for (const orderType of ['self', 'share'] as const) {
      const input: QuoteNInput = {
        platform: 'pdd',
        orderType,
        finalPriceFen: 2990n,
        commissionRateBp: 2000n,
        techFeeBp: value as bigint,
        pdd: { selfBuyFactorBp: 7500n, accountLevelFactorBp: 8000n },
      };
      expect(() => quoteN(input)).toThrow(InvalidRatio);
      expect(() => quoteN({ ...input, finalPriceFen: 0n })).toThrow(InvalidRatio);
      expect(() => quoteN({ ...input, commissionRateBp: 0n })).toThrow(InvalidRatio);
      expect(() =>
        quoteN({ ...input, pdd: { selfBuyFactorBp: 0n, accountLevelFactorBp: 8000n } }),
      ).toThrow(InvalidRatio);
      expect(() =>
        quoteN({ ...input, pdd: { selfBuyFactorBp: 7500n, accountLevelFactorBp: 0n } }),
      ).toThrow(InvalidRatio);
    }
  },
);
