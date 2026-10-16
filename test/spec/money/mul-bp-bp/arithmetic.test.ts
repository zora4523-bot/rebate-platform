import { mulBpBpFloor } from '@couli/money';
import { expect, it } from 'vitest';

// Local AC-B2-01c labels identify task checks, not new business acceptance rules.
// Only BR-CALC-01 and BR-CALC-17 are in scope; platform factors remain caller inputs.
it.each([
  { label: '规则原例：默认因子', amount: 400n, a: 7500n, b: 10000n, expected: 300n },
  { label: '规则原例：两因子均非一', amount: 333n, a: 7500n, b: 8000n, expected: 199n },
  // Either sequential order gives 0; one final floor gives 1.
  { label: '分步 floor 会少一分', amount: 2n, a: 7500n, b: 8000n, expected: 1n },
  { label: '因子互换仍只取整一次', amount: 2n, a: 8000n, b: 7500n, expected: 1n },
  { label: '整数落点前一分', amount: 4n, a: 7500n, b: 8000n, expected: 2n },
  { label: '恰好整数不多减一分', amount: 5n, a: 7500n, b: 8000n, expected: 3n },
  { label: '整数落点后一分', amount: 6n, a: 7500n, b: 8000n, expected: 3n },
  { label: '不足一分不向上取整', amount: 1n, a: 9999n, b: 9999n, expected: 0n },
  { label: '零金额', amount: 0n, a: 7500n, b: 8000n, expected: 0n },
  { label: '两比例均零', amount: 333n, a: 0n, b: 0n, expected: 0n },
  { label: '首比例零', amount: 333n, a: 0n, b: 10000n, expected: 0n },
  { label: '次比例零', amount: 333n, a: 10000n, b: 0n, expected: 0n },
  { label: '两比例上界', amount: 333n, a: 10000n, b: 10000n, expected: 333n },
  { label: '首比例上界', amount: 333n, a: 10000n, b: 8000n, expected: 266n },
  { label: '次比例上界', amount: 333n, a: 8000n, b: 10000n, expected: 266n },
  // Multiplying factors must not floor the product back to a single integer bp first.
  { label: '因子乘积不足一 bp 仍保留', amount: 100000000n, a: 1n, b: 1n, expected: 1n },
  { label: '非整 bp 乘积', amount: 100000000n, a: 3333n, b: 3333n, expected: 11108889n },
  {
    label: '超过安全 number 的奇数分原样保留',
    amount: 9007199254740993n,
    a: 10000n,
    b: 10000n,
    expected: 9007199254740993n,
  },
  {
    label: '超过安全 number 的金额仍正确舍尾',
    amount: 9007199254740993n,
    a: 7500n,
    b: 8000n,
    expected: 5404319552844595n,
  },
  {
    label: 'int64 最大金额的中间乘积不溢出',
    amount: 9223372036854775807n,
    a: 10000n,
    b: 10000n,
    expected: 9223372036854775807n,
  },
  {
    label: 'int64 最大金额双比例精确舍尾',
    amount: 9223372036854775807n,
    a: 7500n,
    b: 8000n,
    expected: 5534023222112865484n,
  },
])('[AC-B2-01c#1][BR-CALC-01][BR-CALC-17] $label', ({ amount, a, b, expected }) => {
  expect(mulBpBpFloor(amount, a, b)).toBe(expected);
});

it('[AC-B2-01c#2][BR-CALC-17] 边界组合满足 floor 的上下界且不超过原金额', () => {
  const amounts = [0n, 1n, 2n, 3n, 5n, 333n, 10001n, 9007199254740993n, 9223372036854775807n];
  const ratios = [0n, 1n, 3333n, 7500n, 8000n, 9999n, 10000n];
  for (const amount of amounts) {
    for (const a of ratios) {
      for (const b of ratios) {
        const result = mulBpBpFloor(amount, a, b);
        const numerator = amount * a * b;
        expect(typeof result).toBe('bigint');
        expect(result).toBeGreaterThanOrEqual(0n);
        expect(result).toBeLessThanOrEqual(amount);
        // Characterize floor without reproducing the implementation's division.
        expect(result * 100000000n).toBeLessThanOrEqual(numerator);
        expect((result + 1n) * 100000000n).toBeGreaterThan(numerator);
      }
    }
  }
});
