// B2-08c (static; task §9.2 3, 4; 编排裁定 D10-456 ④): production assembly of the tax calculator.
// payout exports createFeeTaxCalculator through its index.ts; app.module builds the withdrawal
// rules' fee / tax port with it — content's configuration reader and identity's
// realname-identity-key port handed in (02 §4.1: payout imports nothing from identity) — instead
// of createDefaultFeeTaxCalculator(), which stays for the earlier kits. The calculator reads time
// only from its input (no wall clock, no host-zone year) and no environment variable.
// Reads the sources only; the behaviour is in the calculator / apply tests.
// Top-level it() only (规划/11 §4.3).
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const SRC = '../../../../apps/api/src/';

function source(path: string): string {
  return readFileSync(new URL(`${SRC}${path}`, import.meta.url), 'utf8');
}

/** The argument text of every call matching `callee` (a regex source), parentheses balanced. */
function calls(text: string, callee: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(`${callee}\\s*\\(`, 'g'))) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let end = start;
    while (end < text.length && depth > 0) {
      const ch = text[end];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      end += 1;
    }
    found.push(text.slice(start, end - 1));
  }
  return found;
}

/** The names a file imports from `specifier` (value and type imports). */
function importedFrom(text: string, specifier: string): string[] {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const names: string[] = [];
  for (const match of text.matchAll(
    new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*'${escaped}'`, 'g'),
  )) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part
        .replace(/\btype\b/, '')
        .trim()
        .split(/\s+as\s+/)[0];
      if (name) names.push(name);
    }
  }
  return names;
}

const APP_MODULE = 'app.module.ts';
const PAYOUT_INDEX = 'modules/payout/index.ts';
const CALCULATOR = 'modules/payout/application/fee-tax-calculator.ts';
const PAYOUT_FILES = [
  CALCULATOR,
  'modules/payout/application/withdraw-rules.ts',
  'modules/payout/application/withdraw-apply.ts',
  PAYOUT_INDEX,
];

it('[AC-B2-08c#wiring] app.module：提现规则的 feeTax 用 payout/index.ts 导出的 createFeeTaxCalculator 构造（带 config 与 identityKey，identity 的 createRealnameIdentityKeyReader），不再是 createDefaultFeeTaxCalculator()', () => {
  const app = source(APP_MODULE);
  expect(importedFrom(app, './modules/payout/index.ts')).toContain('createFeeTaxCalculator');
  const built = calls(app, '\\bcreateFeeTaxCalculator');
  expect(built.length).toBeGreaterThan(0);
  for (const call of built) {
    expect(call, `createFeeTaxCalculator(${call})`).toMatch(/\bconfig\b/);
    expect(call, `createFeeTaxCalculator(${call})`).toMatch(/\bidentityKey\b/);
  }
  expect(app).toMatch(/\bcreateRealnameIdentityKeyReader\s*\(/);
  expect(app).not.toMatch(/\bfeeTax\s*:\s*createDefaultFeeTaxCalculator\s*\(/);
  expect(source(PAYOUT_INDEX)).toMatch(
    /export\s*\{[^}]*\bcreateFeeTaxCalculator\b[^}]*\}\s*from\s*'\.\/application\/fee-tax-calculator\.ts'/,
  );
});

it('[AC-B2-08c#wiring] payout 的计算器与申请源码不导入 identity；计算器不读墙钟、不按宿主时区取年、不读环境变量、不用 console（且已被 app.module 装配）', () => {
  expect(calls(source(APP_MODULE), '\\bcreateFeeTaxCalculator').length).toBeGreaterThan(0);
  for (const path of PAYOUT_FILES) {
    expect(source(path), path).not.toMatch(/from\s*'[^']*\/identity\//);
  }
  const calculator = source(CALCULATOR);
  expect(calculator).not.toMatch(/\bnew\s+Date\s*\(/);
  expect(calculator).not.toMatch(/\bDate\.now\s*\(/);
  expect(calculator).not.toMatch(/\.get(?:UTC)?FullYear\s*\(/);
  expect(calculator).not.toMatch(/\bprocess\.env\b/);
  expect(calculator).not.toMatch(/\bconsole\./);
});
