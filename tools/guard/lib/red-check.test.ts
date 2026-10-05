// Unit tests of the red check (规划/11 §2.3 step 3; ops/approvals.yaml id 19).
import { expect, it } from 'vitest';
import { checkRedReport, redCheckRequired, wrongRedReason } from './red-check.ts';

const GLOBS = ['test/spec/**', 'test/properties/**', 'test/acceptance/**'];
const ROOT = '/work/repo';

function report(
  files: Array<{ name: string; message?: string; tests: Array<[string, string, string?]> }>,
) {
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
  expect(
    wrongRedReason('Property failed after 1 tests\nCounterexample: [0]\nGot error: AssertionError'),
  ).toBeNull();
  expect(wrongRedReason('Error: NotImplemented: splitCommission')).toBeNull();
  expect(wrongRedReason("Error: Cannot find module '../src/split.ts'")).toContain('wrong reason');
  expect(wrongRedReason("TypeError: Cannot read properties of undefined (reading 'x')")).toContain(
    'TypeError',
  );
  // A counterexample whose error is a TypeError is a crash, not a rule violation.
  expect(
    wrongRedReason('Property failed after 1 tests\nGot error: TypeError: x is not a function'),
  ).toContain('TypeError');
  expect(wrongRedReason('Error: boom')).toContain('unrecognised');
});

it('[规划/11 §2.3] a report passes only when every rule test is red for the right reason', () => {
  const good = checkRedReport(
    report([
      {
        name: 'test/spec/money/split.test.ts',
        tests: [['splits [AC-1]', 'failed', 'AssertionError: expected 1 to be 2']],
      },
      {
        name: 'test/properties/money/sum.test.ts',
        tests: [['sums', 'failed', 'Error: NotImplemented']],
      },
      // Unit tests elsewhere are not rule tests and are ignored.
      { name: 'packages/money/src/a.test.ts', tests: [['unit', 'passed']] },
    ]),
    GLOBS,
    ROOT,
  );
  expect(good).toEqual({
    ok: true,
    red: [
      'test/spec/money/split.test.ts > splits [AC-1]',
      'test/properties/money/sum.test.ts > sums',
    ],
    problems: [],
  });

  const bad = checkRedReport(
    report([
      {
        name: 'test/spec/money/split.test.ts',
        tests: [
          ['green one', 'passed'],
          ['crashes', 'failed', 'TypeError: f is not a function'],
          ['skipped', 'skipped'],
        ],
      },
      {
        name: 'test/spec/money/missing.test.ts',
        message: "Error: Failed to resolve import '../x.ts'",
        tests: [],
      },
    ]),
    GLOBS,
    ROOT,
  );
  expect(bad.ok).toBe(false);
  expect(bad.problems.map((p) => `${p.test ?? '(file)'}: ${p.reason.split(' (')[0]}`)).toEqual([
    'green one: green on the skeleton: the test has no teeth',
    'crashes: red for the wrong reason',
    'skipped: status "skipped"',
    '(file): the file did not load: red for the wrong reason',
  ]);
  expect(checkRedReport(report([]), GLOBS, ROOT).problems[0]?.reason).toContain(
    'no rule-test file',
  );
  expect(checkRedReport({ nope: true }, GLOBS, ROOT).ok).toBe(false);
});
