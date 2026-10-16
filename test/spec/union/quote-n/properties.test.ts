import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { quoteN, type QuoteNInput } from '../../../../apps/api/src/modules/union/index.ts';

const amount = fc.bigInt({ min: 0n, max: 9223372036854775807n });
const ratio = fc.bigInt({ min: 0n, max: 10000n });

it.each(['taobao', 'jd'] as const)(
  '[AC-B2-03b#14][BR-CALC-20] %s 两订单类型满足服务费 floor 区间及金额上下界',
  (platform) => {
    fc.assert(
      fc.property(amount, ratio, ratio, (finalPriceFen, commissionRateBp, techFeeBp) => {
        const gross = (finalPriceFen * commissionRateBp) / 10000n;
        for (const orderType of ['self', 'share'] as const) {
          const result = quoteN({
            platform,
            orderType,
            finalPriceFen,
            commissionRateBp,
            techFeeBp,
          });
          expect(typeof result).toBe('bigint');
          expect(result).toBeGreaterThanOrEqual(0n);
          expect(result).toBeLessThanOrEqual(finalPriceFen);
          const deductedFee = gross - result;
          // Independent floor characterization, without calling money helpers as the oracle.
          expect(deductedFee * 10000n).toBeLessThanOrEqual(gross * techFeeBp);
          expect((deductedFee + 1n) * 10000n).toBeGreaterThan(gross * techFeeBp);
        }
      }),
      propParams(),
    );
  },
);

it.each(['self', 'share'] as const)(
  '[AC-B2-03b#15][BR-CALC-17] 拼多多 %s 符合一次 floor 区间，结果不超券后价',
  (orderType) => {
    fc.assert(
      fc.property(
        amount,
        ratio,
        ratio,
        ratio,
        (finalPriceFen, commissionRateBp, selfBuyFactorBp, accountLevelFactorBp) => {
          const result = quoteN({
            platform: 'pdd',
            orderType,
            finalPriceFen,
            commissionRateBp,
            techFeeBp: 0n,
            pdd: { selfBuyFactorBp, accountLevelFactorBp },
          });
          const gross = (finalPriceFen * commissionRateBp) / 10000n;
          const numerator =
            orderType === 'self'
              ? gross * selfBuyFactorBp * accountLevelFactorBp
              : gross * accountLevelFactorBp;
          const denominator = orderType === 'self' ? 100000000n : 10000n;
          expect(typeof result).toBe('bigint');
          expect(result).toBeGreaterThanOrEqual(0n);
          expect(result).toBeLessThanOrEqual(finalPriceFen);
          expect(result * denominator).toBeLessThanOrEqual(numerator);
          expect((result + 1n) * denominator).toBeGreaterThan(numerator);
        },
      ),
      propParams(),
    );
  },
);

it.each(['taobao', 'jd', 'pdd'] as const)(
  '[AC-B2-03b#16][BR-CALC-17][BR-CALC-20] %s 不修改输入，交错调用后同输入仍同输出',
  (platform) => {
    const input: QuoteNInput = Object.freeze({
      platform,
      orderType: 'self',
      finalPriceFen: 333n,
      commissionRateBp: 10000n,
      techFeeBp: 0n,
      pdd: Object.freeze({ selfBuyFactorBp: 7500n, accountLevelFactorBp: 8000n }),
    });
    const snapshot = { ...input, pdd: { ...input.pdd } };
    const first = quoteN(input);
    expect(first).toBe(platform === 'pdd' ? 199n : 333n);
    expect(quoteN({ ...input, orderType: 'share' })).toBe(platform === 'pdd' ? 266n : 333n);
    expect(quoteN({ ...input, finalPriceFen: 0n })).toBe(0n);
    expect(quoteN(input)).toBe(first);
    expect(quoteN({ ...input, pdd: { ...input.pdd } } as QuoteNInput)).toBe(first);
    expect(input).toEqual(snapshot);
  },
);
