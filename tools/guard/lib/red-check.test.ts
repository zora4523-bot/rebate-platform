// Unit tests of the red check (规划/11 §2.3 step 3; ops/approvals.yaml id 19; Codex review
// CR-10, CR-11 of 2026-10-05).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  causeVerdict,
  checkRedReports,
  expectedRuleTests,
  redCheckRequired,
  wrongRedReason,
} from './red-check.ts';

const ROOT = '/work/repo';

type T = [string, string, string?];
function report(files: Array<{ name: string; message?: string; tests: T[] }>) {
  return {
    testResults: files.map((f) => ({
      name: `${ROOT}/${f.name}`,
      status: 'failed',
      message: f.message ?? '',
      assertionResults: f.tests.map(([title, status, message]) => ({
        fullName: title,
        title,
        status,
        failureMessages: message === undefined ? [] : [message],
      })),
    })),
  };
}

it('[ops/approvals.yaml id 19] applies to every task with a rule-test author, RV0 / RV1 included', () => {
  expect(redCheckRequired({ tester: 'codex' })).toBe(true);
  expect(redCheckRequired({ tester: 'claude' })).toBe(true);
  expect(redCheckRequired({ tester: 'none' })).toBe(false);
});

it('[规划/11 §2.3] red for the right reason: assertion, counterexample, NotImplemented', () => {
  expect(wrongRedReason('AssertionError: expected 3 to be 4')).toBeNull();
  // A plain property failure without its cause proves nothing (CR2-03).
  expect(wrongRedReason('Property failed after 1 tests\nCounterexample: [0]')).toContain(
    'shows no underlying assertion',
  );
  expect(
    wrongRedReason(
      'Property failed after 1 tests\nCounterexample: [0]\nGot error: AssertionError: x',
    ),
  ).toBeNull();
  expect(wrongRedReason('Error: NotImplemented: splitCommission')).toBeNull();
  expect(wrongRedReason("Error: Cannot find module '../src/split.ts'")).toContain(
    'module not found',
  );
  expect(wrongRedReason("TypeError: Cannot read properties of undefined (reading 'x')")).toContain(
    'TypeError',
  );
  expect(wrongRedReason('Error: boom')).toContain('unrecognised');
});

it('[CR-11] infrastructure failures wrapped by fast-check or a hook are never a valid red', () => {
  const wrapped = (cause: string): string =>
    `Property failed after 1 tests\n{ seed: 1 }\nCounterexample: [0]\nGot error: ${cause}`;
  expect(wrongRedReason(wrapped('Error: connect ECONNREFUSED 127.0.0.1:5432'))).toContain(
    'network or database unreachable',
  );
  expect(wrongRedReason(wrapped('error: password authentication failed for user "x"'))).toContain(
    'database connection failed',
  );
  expect(wrongRedReason('Error: migration 0007_ledger.sql failed: relation exists')).toContain(
    'migration failed',
  );
  expect(wrongRedReason('Error: Hook timed out in 10000ms.')).toContain('test setup failed');
  expect(wrongRedReason('Error: health check of the mock server failed')).toContain(
    'server not up',
  );
  expect(wrongRedReason('Error: Build failed with 1 error')).toContain('build failed');
  // A counterexample whose cause is not an assertion is not counted either.
  expect(wrongRedReason(wrapped('Error: boom'))).toContain('shows no underlying assertion');
});

it('[CR-10] the expected rule-test files are the ones the task added inside its test_paths', () => {
  expect(
    expectedRuleTests(
      [
        { path: 'test/spec/money/a.test.ts', status: '?' },
        { path: 'test/spec/money/b.int.test.ts', status: 'A' },
        { path: 'test/spec/money/arb.ts', status: '?' },
        { path: 'test/spec/other/c.test.ts', status: '?' },
        { path: 'test/spec/money/gone.test.ts', status: 'D' },
      ],
      ['test/spec/money/**'],
    ),
  ).toEqual(['test/spec/money/a.test.ts', 'test/spec/money/b.int.test.ts']);
});

it('[CR-10] every expected file must have run and be red; a partial report fails', () => {
  const a = 'test/spec/money/a.test.ts';
  const b = 'test/spec/money/b.test.ts';
  const both = [a, b];
  const good = checkRedReports(
    [
      report([
        { name: a, tests: [['splits [AC-1]', 'failed', 'AssertionError: expected 1 to be 2']] },
      ]),
      report([{ name: b, tests: [['sums', 'failed', 'Error: NotImplemented']] }]),
    ],
    both,
    ROOT,
  );
  expect(good).toEqual({
    ok: true,
    red: [`${a} > splits [AC-1]`, `${b} > sums`],
    problems: [],
  });

  // B never ran: the run picked A only.
  const partial = checkRedReports(
    [report([{ name: a, tests: [['splits', 'failed', 'AssertionError: x']] }])],
    both,
    ROOT,
  );
  expect(partial.ok).toBe(false);
  expect(partial.problems).toEqual([
    { file: b, test: null, reason: 'not in the report: this rule-test file did not run' },
  ]);

  const bad = checkRedReports(
    [
      report([
        {
          name: a,
          tests: [
            ['green one', 'passed'],
            ['crashes', 'failed', 'TypeError: f is not a function'],
            ['skipped', 'skipped'],
          ],
        },
        { name: b, message: "Error: Failed to resolve import '../x.ts'", tests: [] },
      ]),
    ],
    both,
    ROOT,
  );
  expect(bad.problems.map((p) => `${p.test ?? '(file)'}: ${p.reason.split(' (')[0]}`)).toEqual([
    'green one: green on the skeleton: the test has no teeth',
    'crashes: red for the wrong reason',
    'skipped: status "skipped"',
    '(file): the file did not load: red for the wrong reason',
  ]);
  // A file-level setup failure taints the tests that failed next to it.
  const tainted = checkRedReports(
    [
      report([
        {
          name: a,
          message: 'Error: connect ECONNREFUSED pg:5432',
          tests: [['t', 'failed', 'AssertionError: x']],
        },
      ]),
    ],
    [a],
    ROOT,
  );
  expect(tainted.problems[0]?.reason).toContain('network or database unreachable');
  expect(checkRedReports([report([])], [], ROOT).problems[0]?.reason).toContain(
    'added no rule-test file',
  );
  expect(checkRedReports([{ nope: true }], [a], ROOT).ok).toBe(false);
});

const FIXTURES = join(import.meta.dirname, 'red-check-fixtures');
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown;
const P = 'test/spec/zzprobe/p.test.ts';
const M = 'test/spec/zzprobe2/m.test.ts';

it('[CR2-03] real red-reporter output: only assertions and NotImplemented are a valid red', () => {
  // Written by tools/ops/verify-image/red-reporter.mjs on real Vitest 5 + fast-check 4 failures
  // (paths rewritten to the container's /work/repo).
  const result = checkRedReports([fixture('red-report.json')], [P, M], ROOT);
  expect(result.red).toEqual([
    `${P} > [AC-P#2] assertion inside property`,
    `${P} > [AC-P#5] NotImplemented inside property`,
    `${P} > [AC-P#6] plain assertion`,
  ]);
  expect(result.problems.map((p) => `${p.test ?? p.file}: ${p.reason.split(' (')[0]}`)).toEqual([
    '[AC-P#1] typeerror inside property: red for the wrong reason',
    '[AC-P#3] property returns false: red for an unrecognised reason',
    '[AC-P#4] database refused inside property: red for the wrong reason',
    '[AC-P#7] skipped: status "skipped"',
    `${M}: the file did not load: red for the wrong reason`,
  ]);
  expect(result.problems[0]?.reason).toContain('TypeError');
  expect(result.problems[1]?.reason).toContain('property returned false');
  expect(result.problems[2]?.reason).toContain('network or database unreachable');
});

it('[CR2-03] real Vitest JSON output (no causes): every property failure is refused', () => {
  const result = checkRedReports([fixture('json-report.json')], [P], ROOT);
  const property = result.problems.filter((p) =>
    p.reason.includes('shows no underlying assertion'),
  );
  // P#1..P#5 are properties: Vitest's JSON reporter drops the cause, so none of them counts.
  expect(property.map((p) => p.test)).toEqual([
    '[AC-P#1] typeerror inside property',
    '[AC-P#2] assertion inside property',
    '[AC-P#3] property returns false',
    '[AC-P#4] database refused inside property',
    '[AC-P#5] NotImplemented inside property',
  ]);
  expect(result.red).toEqual([`${P} > [AC-P#6] plain assertion`]);
});

it('[CR2-03] cause chains: the innermost cause decides; nothing known means refused', () => {
  expect(causeVerdict([])).toContain('no failure detail');
  expect(
    causeVerdict([
      { name: 'Error', message: 'Property failed after 1 tests' },
      { name: 'AssertionError', message: 'expected ECONNREFUSED to be 1' },
    ]),
  ).toBeNull();
  expect(causeVerdict([{ name: 'Error', message: 'boom' }])).toContain(
    'not an assertion or NotImplemented',
  );
  expect(
    checkRedReports(
      [
        {
          testResults: [
            {
              name: `${ROOT}/${P}`,
              assertionResults: [
                { title: 't', status: 'failed', failureMessages: ['x'], failures: [] },
              ],
            },
          ],
        },
      ],
      [P],
      ROOT,
    ).problems[0]?.reason,
  ).toContain('no failure detail');
  expect(
    checkRedReports(
      [
        {
          testResults: [],
          unhandledErrors: [{ causes: [{ name: 'Error', message: 'connect ECONNREFUSED' }] }],
        },
      ],
      [],
      ROOT,
    ).problems.map((p) => p.reason),
  ).toContain(
    'the run had unhandled errors: red for the wrong reason (network or database unreachable)',
  );
});
