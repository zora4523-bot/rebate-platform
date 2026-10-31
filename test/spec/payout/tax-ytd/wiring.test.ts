// B2-08b (static; 编排裁定 D10-181 ①, D10-459; task §9.2 3, 4): production assembly of the tax_ytd
// accumulation. identity declares realname-identity-key in identity/ports and exports it through
// identity/index.ts; app.module builds it and hands it to payout — the worker's
// PayoutModule.forWorker (whose landing job gets it) and the admin write-off's
// createWithdrawalProvenSuccess — while payout itself imports nothing from identity (02 §4.1: other
// modules only through their index.ts, and payout takes identity's ports by dependency inversion).
// The new options are optional for the earlier kits, so only the assembly shows they are passed.
// Reads the sources only; the behaviour is in landing / proven-success / accumulator .int tests.
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
const PAYOUT_MODULE = 'modules/payout/payout.module.ts';
const IDENTITY_INDEX = 'modules/identity/index.ts';
const PAYOUT_FILES = [
  'modules/payout/application/tax-ytd.ts',
  'modules/payout/application/payout-landing.ts',
  'modules/payout/application/withdrawal-proven-success.ts',
  'modules/payout/jobs/landing-job.ts',
  'modules/payout/payout.module.ts',
  'modules/payout/index.ts',
];

it('[AC-B2-08b#wiring] worker：PayoutModule.forWorker 收到 identityKey，app.module 用 identity/index.ts 导出的 createRealnameIdentityKeyReader 构造；forWorker 里每个 createLandingJob 都带 identityKey', () => {
  const app = source(APP_MODULE);
  expect(importedFrom(app, './modules/identity/index.ts')).toContain(
    'createRealnameIdentityKeyReader',
  );
  expect(app).toMatch(/\bcreateRealnameIdentityKeyReader\s*\(/);
  const workers = calls(app, 'PayoutModule\\.forWorker');
  expect(workers.length).toBeGreaterThan(0);
  for (const call of workers) {
    expect(call, `PayoutModule.forWorker(${call})`).toMatch(/\bidentityKey\b/);
  }
  const landings = calls(source(PAYOUT_MODULE), '\\bcreateLandingJob');
  expect(landings.length).toBeGreaterThan(0);
  for (const call of landings) {
    expect(call, `createLandingJob(${call})`).toMatch(/\bidentityKey\b/);
  }
});

it('[AC-B2-08b#wiring] admin 核销：app.module 里每个 createWithdrawalProvenSuccess 都带 identityKey（createRealnameIdentityKeyReader）；端口经 identity/index.ts 导出；payout 的源码不导入 identity', () => {
  const app = source(APP_MODULE);
  const proven = calls(app, '\\bcreateWithdrawalProvenSuccess');
  expect(proven.length).toBeGreaterThan(0);
  for (const call of proven) {
    expect(call, `createWithdrawalProvenSuccess(${call})`).toMatch(/\bidentityKey\b/);
  }
  expect(app).toMatch(/\bcreateRealnameIdentityKeyReader\s*\(/);
  expect(source(IDENTITY_INDEX)).toMatch(
    /export\s*\{[^}]*\bcreateRealnameIdentityKeyReader\b[^}]*\}\s*from\s*'\.\/ports\/realname-identity-key\.ts'/,
  );
  for (const path of PAYOUT_FILES) {
    expect(source(path), path).not.toMatch(/from\s*'[^']*\/identity\//);
  }
});
