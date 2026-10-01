// Property tests for parseFen / formatFen / yuanStrToFen / fenToJsonNumber (规划/08 BR-CALC-01
// 整数分与序列化, BR-CALC-26 元字符串换算; 规划/11 §4.2–§4.3). Amounts are generated as bigint
// or as decimal strings, never as JS numbers (except where a number must be rejected).
import { fenToJsonNumber, formatFen, InvalidAmount, parseFen, yuanStrToFen } from '@couli/money';
import { createPropStats, propParams, propRuns } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  amountFen,
  bucketOf,
  coverage,
  FULL_COVERAGE,
  MAX_SAFE,
  signedFen,
  throwsInstanceOf,
} from './arb.ts';

const digits = (min: number, max: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'), {
      minLength: min,
      maxLength: max,
    })
    .map((d) => d.join(''));

it('[BR-CALC-26] formatFen 与 yuanStrToFen 互逆：yuanStrToFen(formatFen(x)) == x，格式为 -?整数.两位', () => {
  const stats = createPropStats('money:formatFen:round-trip');
  fc.assert(
    fc.property(signedFen, (x) => {
      stats.hit(bucketOf(x));
      const text = formatFen(x);
      return /^-?\d+\.\d{2}$/.test(text) && yuanStrToFen(text) === x;
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it("[BR-CALC-26] 小数不超过 2 位时精确换算：'<元>.<d>' → 元×100 + d×10，'<元>.<dd>' → 元×100 + dd", () => {
  const stats = createPropStats('money:yuanStrToFen:exact');
  fc.assert(
    fc.property(amountFen, digits(0, 2), (yuan, frac) => {
      stats.hit(bucketOf(yuan));
      const text = frac === '' ? `${yuan}` : `${yuan}.${frac}`;
      const expected = yuan * 100n + (frac === '' ? 0n : BigInt(frac.padEnd(2, '0')));
      return yuanStrToFen(text) === expected;
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-26] 超过 2 位小数按 floor 取整到分（非负金额）：只取前两位小数', () => {
  const stats = createPropStats('money:yuanStrToFen:floor');
  fc.assert(
    fc.property(amountFen, digits(3, 8), (yuan, frac) => {
      stats.hit(bucketOf(yuan));
      return yuanStrToFen(`${yuan}.${frac}`) === yuan * 100n + BigInt(frac.slice(0, 2));
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-01] parseFen 对 bigint 与其十进制字符串都原样还原（含超过 2^53 与负数）', () => {
  const stats = createPropStats('money:parseFen:bigint-and-string');
  fc.assert(
    fc.property(signedFen, (x) => {
      stats.hit(bucketOf(x));
      return parseFen(x) === x && parseFen(x.toString()) === x;
    }),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});

it('[BR-CALC-01] parseFen 接受安全整数 number，拒绝其余一切 number（小数、NaN、Infinity、|n| > 2^53−1）', () => {
  const stats = createPropStats('money:parseFen:number');
  const anyNumber = fc.oneof(
    fc.maxSafeInteger(),
    fc.double(),
    fc.constantFrom(2 ** 53, -(2 ** 53), 2 ** 60, Number.MAX_VALUE),
  );
  fc.assert(
    fc.property(anyNumber, (n) => {
      const safe = Number.isSafeInteger(n);
      stats.hit(safe ? 'safe_integer' : 'rejected');
      if (safe) {
        try {
          return parseFen(n) === BigInt(n);
        } catch {
          return false;
        }
      }
      return throwsInstanceOf(() => parseFen(n), InvalidAmount);
    }),
    propParams(),
  );
  const hits = stats.flush().hits;
  expect({
    safe_integer: propRuns() < 1000 || (hits['safe_integer'] ?? 0) > 0,
    rejected: propRuns() < 1000 || (hits['rejected'] ?? 0) > 0,
  }).toEqual({ safe_integer: true, rejected: true });
});

it('[BR-CALC-01] 序列化：|x| ≤ 2^53−1 时 fenToJsonNumber 无损，超出时抛 InvalidAmount', () => {
  const stats = createPropStats('money:fenToJsonNumber');
  const nearLimit = fc.oneof(
    fc.bigInt({ min: MAX_SAFE - 8n, max: MAX_SAFE + 8n }),
    fc.bigInt({ min: -MAX_SAFE - 8n, max: -MAX_SAFE + 8n }),
  );
  fc.assert(
    fc.property(
      fc.oneof({ arbitrary: signedFen, weight: 3 }, { arbitrary: nearLimit, weight: 1 }),
      (x) => {
        stats.hit(bucketOf(x));
        const inRange = x <= MAX_SAFE && x >= -MAX_SAFE;
        if (inRange) {
          try {
            const n = fenToJsonNumber(x);
            return Number.isSafeInteger(n) && BigInt(n) === x;
          } catch {
            return false;
          }
        }
        return throwsInstanceOf(() => fenToJsonNumber(x), InvalidAmount);
      },
    ),
    propParams(),
  );
  expect(coverage(stats.flush())).toEqual(FULL_COVERAGE);
});
