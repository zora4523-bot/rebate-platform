import { InvalidAmount, InvalidRatio } from '@couli/money';
import { expect, it } from 'vitest';
import { quoteN, type QuoteNInput } from '../../../../apps/api/src/modules/union/index.ts';

// Deliberately cross the TypeScript boundary; runtime inputs must never be coerced.
const nonBigints: { label: string; value: unknown }[] = [
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
  { label: 'symbol', value: Symbol('invalid') },
  { label: '可强转对象', value: { valueOf: () => 1000n } },
];

const invalidRatios = [
  ...nonBigints,
  { label: '负比例', value: -1n },
  { label: '超过上界', value: 10001n },
  { label: '将系数乘积误作单个系数', value: 75000000n },
];

const bases: readonly QuoteNInput[] = [
  {
    platform: 'taobao',
    orderType: 'self',
    finalPriceFen: 2990n,
    commissionRateBp: 2000n,
    techFeeBp: 1000n,
  },
  {
    platform: 'jd',
    orderType: 'self',
    finalPriceFen: 2990n,
    commissionRateBp: 2000n,
    techFeeBp: 1000n,
  },
  {
    platform: 'pdd',
    orderType: 'self',
    finalPriceFen: 2990n,
    commissionRateBp: 2000n,
    techFeeBp: 0n,
    pdd: { selfBuyFactorBp: 7500n, accountLevelFactorBp: 8000n },
  },
];

it.each([...nonBigints, { label: '负价', value: -1n }])(
  '[AC-B2-03b#8] 三平台两订单类型：$label 金额抛 InvalidAmount，零佣金率也不能绕过',
  ({ value }) => {
    for (const base of bases) {
      for (const orderType of ['self', 'share'] as const) {
        expect(() => quoteN({ ...base, orderType, finalPriceFen: value as bigint })).toThrow(
          InvalidAmount,
        );
        expect(() =>
          quoteN({ ...base, orderType, finalPriceFen: value as bigint, commissionRateBp: 0n }),
        ).toThrow(InvalidAmount);
      }
    }
  },
);

it.each(invalidRatios)(
  '[AC-B2-03b#9] 三平台两订单类型：$label 佣金率抛 InvalidRatio，零价也不能绕过',
  ({ value }) => {
    for (const base of bases) {
      for (const orderType of ['self', 'share'] as const) {
        expect(() => quoteN({ ...base, orderType, commissionRateBp: value as bigint })).toThrow(
          InvalidRatio,
        );
        expect(() =>
          quoteN({ ...base, orderType, finalPriceFen: 0n, commissionRateBp: value as bigint }),
        ).toThrow(InvalidRatio);
      }
    }
  },
);

it.each(invalidRatios)(
  '[AC-B2-03b#10] 淘宝京东：$label 技术服务费率抛 InvalidRatio，零 gross 也不能绕过',
  ({ value }) => {
    for (const platform of ['taobao', 'jd'] as const) {
      for (const orderType of ['self', 'share'] as const) {
        const input: QuoteNInput = {
          platform,
          orderType,
          finalPriceFen: 2990n,
          commissionRateBp: 2000n,
          techFeeBp: value as bigint,
        };
        expect(() => quoteN(input)).toThrow(InvalidRatio);
        expect(() => quoteN({ ...input, finalPriceFen: 0n })).toThrow(InvalidRatio);
        expect(() => quoteN({ ...input, commissionRateBp: 0n })).toThrow(InvalidRatio);
      }
    }
  },
);

it.each(invalidRatios)(
  '[AC-B2-03b#11][BR-CALC-17] 拼多多自购：$label 系数分别校验，零金额或另一个系数零不能绕过',
  ({ value }) => {
    for (const finalPriceFen of [333n, 0n]) {
      for (const validFactor of [8000n, 0n]) {
        const input: QuoteNInput = {
          platform: 'pdd',
          orderType: 'self',
          finalPriceFen,
          commissionRateBp: 10000n,
          techFeeBp: 0n,
        };
        expect(() =>
          quoteN({
            ...input,
            pdd: { selfBuyFactorBp: value as bigint, accountLevelFactorBp: validFactor },
          }),
        ).toThrow(InvalidRatio);
        expect(() =>
          quoteN({
            ...input,
            pdd: { selfBuyFactorBp: validFactor, accountLevelFactorBp: value as bigint },
          }),
        ).toThrow(InvalidRatio);
      }
    }
  },
);

it.each(invalidRatios)(
  '[AC-B2-03b#12][BR-CALC-17] 拼多多分享：$label 账号等级系数抛 InvalidRatio',
  ({ value }) => {
    for (const finalPriceFen of [333n, 0n]) {
      expect(() =>
        quoteN({
          platform: 'pdd',
          orderType: 'share',
          finalPriceFen,
          commissionRateBp: 10000n,
          techFeeBp: 0n,
          pdd: { selfBuyFactorBp: 7500n, accountLevelFactorBp: value as bigint },
        }),
      ).toThrow(InvalidRatio);
    }
  },
);

it.each(['self', 'share'] as const)(
  '[AC-B2-03b#13][BR-CALC-17] 拼多多 %s 必须显式传齐系数，不静默采用默认值',
  (orderType) => {
    for (const finalPriceFen of [400n, 0n]) {
      const input: QuoteNInput = {
        platform: 'pdd',
        orderType,
        finalPriceFen,
        commissionRateBp: 10000n,
        techFeeBp: 0n,
      };
      // Missing configuration is a missing ratio, so use the existing money error family.
      expect(() => quoteN(input)).toThrow(InvalidRatio);
      for (const incomplete of [{}, { selfBuyFactorBp: 7500n }, { accountLevelFactorBp: 10000n }]) {
        expect(() =>
          quoteN({ ...input, pdd: incomplete as QuoteNInput['pdd'] } as QuoteNInput),
        ).toThrow(InvalidRatio);
      }
    }
  },
);
