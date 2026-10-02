// Rule tests added after the second Codex spec-test review of B2-01a (2026-10-02): the gaps it
// found that lie inside this task's paths (packages/money). Source: 规划/08 BR-CALC-01 —
// 「_bp 取值为 0–10000 的整数；输入非整数或超界，函数抛 InvalidRatio，不得静默截断」「需要向上
// 取整的场景用 mulDivCeil，同样只接受非负数」「任何金额路径禁止出现 number 浮点」「禁止先把 bp
// 转成小数」. Expected values are computed by hand from the BR text. Existing test assets are
// unchanged (规划/11 §4.4). Top-level it() only (规划/11 §4.3).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvalidAmount, InvalidRatio, mulDivCeil } from '@couli/money';
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

it('[BR-CALC-01] mulDivCeil 的合法比例包含 0：(100, 0, 10000) → 0，(0, 0, 10000) → 0，(9007199254740993, 0, 10000) → 0', () => {
  expect([
    outcome(() => mulDivCeil(100n, 0n, 10000n)),
    outcome(() => mulDivCeil(0n, 0n, 10000n)),
    outcome(() => mulDivCeil(9007199254740993n, 0n, 10000n)),
  ]).toEqual(['0', '0', '0']);
});

it('[BR-CALC-01] mulDivCeil 的 _bp 非整数或不是 bigint（0.5、1.5、5000 的 number）抛 InvalidRatio，不泄漏 TypeError、不静默截断', () => {
  const ratios: unknown[] = [0.5, 1.5, 5000];
  expect(ratios.map((bp) => outcome(() => mulDivCeil(100n, bp as bigint, 10000n)))).toEqual(
    ratios.map(() => 'InvalidRatio'),
  );
});

const SRC = fileURLToPath(new URL('../../../packages/money/src/', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** Code only: comments, string and template literals and regex literals are blanked out. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
    .replace(/'(?:\\.|[^\\'\n])*'/g, "''")
    .replace(/"(?:\\.|[^\\"\n])*"/g, '""')
    .replace(/(^|[=(,:!&|?;{}]\s*)\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[a-z]*/gm, '$1/r/');
}

// A number literal with a fraction or an exponent (0.5, .5, 5e3, 1.5e-2) is a float on a money
// path; so is arithmetic on a Number(...) conversion. bigint literals (5000n) are not matched.
const FLOAT_LITERAL = /(?<![\w$.])(?:\d[\d_]*\.\d+|\.\d+|\d[\d_]*(?:\.\d+)?[eE][+-]?\d+)(?![\w$])/g;
const NUMBER_ARITHMETIC = /Number\([^()]*\)\s*[-+*/%]|[-+*/%]\s*Number\(/g;

it('[BR-CALC-01] packages/money/src 的非测试源码不出现浮点数字面量（如 0.5、5e3）或对 Number(...) 的算术，禁止先把 bp 转成小数', () => {
  const files = sourceFiles(SRC);
  const hits = files.flatMap((file) => {
    const code = codeOnly(readFileSync(file, 'utf8'));
    return [...code.matchAll(FLOAT_LITERAL), ...code.matchAll(NUMBER_ARITHMETIC)].map(
      (m) => `${file.slice(SRC.length)}: ${m[0]}`,
    );
  });
  expect({ scanned_index: files.some((f) => f.endsWith('index.ts')), hits }).toEqual({
    scanned_index: true,
    hits: [],
  });
});

it('[BR-CALC-01] 上一条的扫描器自身有效：含 0.5、BigInt(0.5 * 10000)、5e3、Number(x) * 100 的源码会被报出，bigint 与注释、字符串里的写法不报', () => {
  const bad = [
    'const r = 0.5;',
    'return a * BigInt(0.5 * 10000) / 10000n;',
    'const d = 5e3;',
    'const y = Number(text) * 100;',
    'const z = .25 + 1;',
  ];
  const good = [
    'return (a * 5000n) / 10000n;',
    '// 1234 * 0.5 is forbidden',
    "throw new Error('ratio 0.5 is not allowed');",
    'const re = /^(-?)([0-9]+)(?:\\.([0-9]+))?$/;',
    'return Number(fen);',
    'const s = `${a}.${b}`;',
  ];
  const count = (src: string) =>
    [...codeOnly(src).matchAll(FLOAT_LITERAL), ...codeOnly(src).matchAll(NUMBER_ARITHMETIC)].length;
  expect({ bad: bad.map((s) => count(s) > 0), good: good.map((s) => count(s)) }).toEqual({
    bad: bad.map(() => true),
    good: good.map(() => 0),
  });
});
