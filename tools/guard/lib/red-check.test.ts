// Unit tests of the red check (规划/11 §2.3 step 3; ops/approvals.yaml id 19; Codex review
// CR-10, CR-11 of 2026-10-05).
import { expect, it } from 'vitest';
import {
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
  expect(wrongRedReason('Property failed after 1 tests\nCounterexample: [0]')).toBeNull();
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
  expect(wrongRedReason(wrapped('Error: boom'))).toContain('not an assertion failure');
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
