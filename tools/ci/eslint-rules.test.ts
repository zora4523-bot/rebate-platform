// Proves that the repo-specific ESLint rules in eslint.config.js can fail (规划/11 §4.1, §4.2):
// lints small sources through stdin under virtual file names, so no fixture file has to live in
// another package. Type-aware rules (no-floating-promises) need real project files and are not
// covered here.
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { beforeAll, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../..');

// The modifiers are spliced in so that this file never contains the literal forms it tests for
// (text-based guards scan test files for them).
const ONLY = ['on', 'ly'].join('');
const SKIP = ['sk', 'ip'].join('');
const TODO = ['to', 'do'].join('');

const SKIPPED_TESTS = `import { describe, expect, it } from 'vitest';
describe.${ONLY}('a', () => {
  it.${SKIP}('b', () => {
    expect(1).toBe(1);
  });
  it.${SKIP}.each([1])('c %s', () => {
    expect(1).toBe(1);
  });
  it['${ONLY}']('d', () => {
    expect(1).toBe(1);
  });
  it.${TODO}('e');
  it('f', (ctx) => {
    ctx.${SKIP}();
    expect(1).toBe(1);
  });
});
`;

const CLOCK_AND_FLOAT = `export const a = new Date();
export const b = Date.now();
export const c = a.toISOString().slice(0, 10);
export const d = parseFloat('1.5');
export const e = Number.parseFloat('1.5');
export const f = (1.5).toFixed(2);
`;

const CONSOLE = `console.log('x');
`;

// name -> [virtual path, source]
const CASES: Record<string, [string, string]> = {
  skippedSpec: ['test/spec/sample.test.ts', SKIPPED_TESTS],
  skippedUnit: ['tools/guard/sample.test.ts', SKIPPED_TESTS],
  moneyScript: ['packages/money/scripts/sample.ts', CLOCK_AND_FLOAT],
  domainTest: [
    'packages/domain/scripts/sample.test.ts',
    `${CLOCK_AND_FLOAT}it.${ONLY}('x', () => {});\n`,
  ],
  dbScriptFile: ['packages/db/sample.ts', CLOCK_AND_FLOAT],
  // outside src/ on purpose: the type-aware block needs real project files (see header)
  apiFile: ['apps/api/sample.ts', CLOCK_AND_FLOAT],
  apiScript: ['apps/api/scripts/sample.ts', CLOCK_AND_FLOAT],
  consoleInPackage: ['packages/db/sample.ts', CONSOLE],
  consoleInTools: ['tools/ops/sample.ts', CONSOLE],
  consoleInScripts: ['packages/db/scripts/sample.ts', CONSOLE],
};

type LintMessage = { ruleId: string | null; severity: number };

const results: Record<string, { status: number | null; rules: string[] }> = {};

function lint(
  virtualPath: string,
  source: string,
): Promise<{ status: number | null; rules: string[] }> {
  return new Promise((done, fail) => {
    const child = spawn(
      join(REPO, 'node_modules/.bin/eslint'),
      ['--stdin', '--stdin-filename', virtualPath, '--format', 'json'],
      { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', fail);
    child.on('close', (status) => {
      try {
        const report = JSON.parse(stdout) as { messages: LintMessage[] }[];
        const rules = report.flatMap((file) => file.messages.map((m) => String(m.ruleId))).sort();
        done({ status, rules });
      } catch {
        fail(new Error(`eslint produced no JSON for ${virtualPath}: ${stderr}`));
      }
    });
    child.stdin.end(source);
  });
}

beforeAll(async () => {
  const entries = Object.entries(CASES);
  const linted = await Promise.all(entries.map(([, [path, source]]) => lint(path, source)));
  entries.forEach(([name], i) => {
    const result = linted[i];
    if (result) results[name] = result;
  });
}, 180_000);

it('forbids focused, skipped and todo tests in rule tests and unit tests', () => {
  const six = Array.from({ length: 6 }, () => 'no-restricted-syntax');
  expect(results['skippedSpec']).toEqual({ status: 1, rules: six });
  expect(results['skippedUnit']).toEqual({ status: 1, rules: six });
});

it('forbids wall-clock time and floating-point helpers in money and domain', () => {
  const six = Array.from({ length: 6 }, () => 'no-restricted-syntax');
  expect(results['moneyScript']).toEqual({ status: 1, rules: six });
  // money/domain tests get both lists: the six above plus the focused test
  expect(results['domainTest']).toEqual({ status: 1, rules: [...six, 'no-restricted-syntax'] });
  // the same source outside money/domain is fine
  expect(results['dbScriptFile']).toEqual({ status: 0, rules: [] });
});

it('forbids wall-clock time in app code outside the clock module', () => {
  // `new Date(` and `Date.now(`; the float helpers are a money/domain rule only
  expect(results['apiFile']).toEqual({
    status: 1,
    rules: ['no-restricted-syntax', 'no-restricted-syntax'],
  });
  expect(results['apiScript']).toEqual({ status: 0, rules: [] });
});

it('forbids console outside tools/ and scripts/', () => {
  expect(results['consoleInPackage']).toEqual({ status: 1, rules: ['no-console'] });
  expect(results['consoleInTools']).toEqual({ status: 0, rules: [] });
  expect(results['consoleInScripts']).toEqual({ status: 0, rules: [] });
});
