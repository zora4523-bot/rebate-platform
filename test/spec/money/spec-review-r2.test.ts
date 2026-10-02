// Rule tests added after the Codex spec-test review of B2-01a (2026-10-02, round 2): the in-scope
// gaps it found in BR-CALC-01 (mulDivCeil exactness above 2^53, bp lower bound) and BR-CALC-26
// (decimal-exact percentages, floor of negative yuan strings, no Number arithmetic when parsing).
// Expected values are computed by hand from the BR text. Existing test assets are unchanged
// (规划/11 §4.4). Top-level it() only (规划/11 §4.3).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvalidAmount, InvalidRatio, mulDivCeil, pctStrToBp, yuanStrToFen } from '@couli/money';
import { expect, it } from 'vitest';

/** Outcome of one call as a string, so a failure lists every offending input at once. */
function outcome(run: () => bigint): string {
  try {
    return String(run());
  } catch (error) {
    if (error instanceof InvalidAmount) return 'InvalidAmount';
    if (error instanceof InvalidRatio) return 'InvalidRatio';
    return String(error);
  }
}

it("[BR-CALC-26] 百分比按十进制精确换算，不经浮点：'0.29' → 29，'0.57' → 57，'1.13' → 113，'4.35' → 435，'8.2' → 820", () => {
  // Number(text) * 100 gives 28.999…, 56.999…, 112.999…, 434.999…, 819.999…: a truncating
  // float implementation is one bp short on each of these.
  const inputs = ['0.29', '0.57', '1.13', '4.35', '8.2'];
  expect(inputs.map((text) => outcome(() => pctStrToBp(text)))).toEqual([
    '29',
    '57',
    '113',
    '435',
    '820',
  ]);
});

it("[BR-CALC-26] 百分比边界：'0' 与 '0.00' → 0，'100.00' → 10000，超过 2 位小数 floor：'99.999' → 9999，'0.009' → 0", () => {
  const inputs = ['0', '0.00', '100.00', '99.999', '0.009'];
  expect(inputs.map((text) => outcome(() => pctStrToBp(text)))).toEqual([
    '0',
    '0',
    '10000',
    '9999',
    '0',
  ]);
});

it("[BR-CALC-01] bp 不得为负：pctStrToBp('-0.01')、('-1')、('-0.001') 抛 InvalidRatio", () => {
  const inputs = ['-0.01', '-1', '-0.001'];
  expect(inputs.map((text) => outcome(() => pctStrToBp(text)))).toEqual(
    inputs.map(() => 'InvalidRatio'),
  );
});

it("[BR-CALC-26] 负金额超过 2 位小数也按 floor（向负无穷）取整到分：'-3.201' → -321，'-0.001' → -1，'-14.526' → -1453；尾数全为 0 不多减：'-3.200' → -320", () => {
  const inputs = ['-3.201', '-3.209', '-0.001', '-14.526', '-3.200', '-0.000'];
  expect(inputs.map((text) => outcome(() => yuanStrToFen(text)))).toEqual([
    '-321',
    '-321',
    '-1',
    '-1453',
    '-320',
    '0',
  ]);
});

it('[BR-CALC-01] mulDivCeil 在超过 2^53 的金额上逐分精确：(2^53+1, 10000) → 2^53+1，(2^53+1, 5000) → 4503599627370497，(INT64_MAX, 3333) → 3074149899883696777', () => {
  const INT64_MAX = 9223372036854775807n;
  const cases: Array<[bigint, bigint, bigint]> = [
    [9007199254740993n, 10000n, 9007199254740993n],
    [9007199254740993n, 5000n, 4503599627370497n],
    [9007199254740993n, 9999n, 9006298534815519n],
    [INT64_MAX, 3333n, 3074149899883696777n],
    [INT64_MAX, 1n, 922337203685478n],
  ];
  // Hand check of each expected value r: (r - 1) * 10000 < a * bp <= r * 10000.
  const handChecked = cases.every(
    ([a, bp, r]) => (r - 1n) * 10000n < a * bp && a * bp <= r * 10000n,
  );
  expect({
    handChecked,
    got: cases.map(([a, bp]) => outcome(() => mulDivCeil(a, bp, 10000n))),
  }).toEqual({ handChecked: true, got: cases.map(([, , r]) => String(r)) });
});

it('[BR-CALC-26] 金额与比例解析不用 Number 运算：packages/money/src 的非测试源码里 Number(…) 只出现在 fenToJsonNumber（BR-CALC-01 序列化）中，也不用 parseInt', () => {
  const src = fileURLToPath(new URL('../../../packages/money/src/', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path);
    }
  };
  walk(src);
  const hits = files.flatMap((file) => {
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
      // The one allowed use: the body of fenToJsonNumber, up to the first closing brace at
      // column 0 after its declaration.
      .replace(/export function fenToJsonNumber\b[\s\S]*?\n\}/, '');
    return [...code.matchAll(/\bNumber\s*\(|\bparseInt\b|\bNumber\.parse(Int|Float)\b/g)].map(
      (m) => `${file.slice(src.length)}: ${m[0]}`,
    );
  });
  expect({ scanned_index: files.some((f) => f.endsWith('index.ts')), hits }).toEqual({
    scanned_index: true,
    hits: [],
  });
});
