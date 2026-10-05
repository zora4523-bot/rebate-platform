// Red check of the rule tests (规划/11 §2.3 step 3): before the implementation, every rule test
// must be red, and red for the right reason — an assertion failure, a fast-check counterexample,
// or the NotImplemented a skeleton throws. Red because a module is missing, a TypeError, a
// ReferenceError or a syntax error does not count: such a test has not been shown to have teeth.
//
// Scope (default split of 2026-10-05, ops/approvals.yaml id 19; 规划/11 §2.3 step 3): every task
// that has a rule-test author (ledger `tester` is not `none`), at every risk level — RV2 always
// had it; RV0 / RV1 tasks with a tester now write their tests first and red as well.
//
// Input is the Vitest JSON report (`vitest run --reporter=json`) of a run of the rule-test files
// on the skeleton. That run executes Codex-written tests, so it happens in the isolated verify
// container, never on the host (规划/11 §2.3 steps 5 and 7, §8).
import { matchesAny } from '../../lib/glob.ts';
import type { TaskFile } from '../../lib/task-file.ts';

/** True when the task must show red rule tests before it is implemented. */
export function redCheckRequired(task: Pick<TaskFile, 'tester'>): boolean {
  return task.tester !== 'none';
}

type AssertionResult = {
  fullName?: unknown;
  title?: unknown;
  status?: unknown;
  failureMessages?: unknown;
};
type FileResult = {
  name?: unknown;
  status?: unknown;
  message?: unknown;
  assertionResults?: unknown;
};

export type RedProblem = { file: string; test: string | null; reason: string };
export type RedResult = { ok: boolean; red: string[]; problems: RedProblem[] };

/** Failures that do not prove anything about the rule (checked first: they win). */
const WRONG_RED =
  /Cannot find module|Failed to load url|Failed to resolve import|ERR_MODULE_NOT_FOUND|\bTypeError\b|\bReferenceError\b|\bSyntaxError\b/;
/** Failures that do: an assertion, a property counterexample, the skeleton's NotImplemented. */
const RIGHT_RED =
  /AssertionError|\bexpected\b[\s\S]*\bto\b|Property failed after|Counterexample|\bNotImplemented\b/;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Why a failure message does or does not count as red for the right reason (null = counts). */
export function wrongRedReason(message: string): string | null {
  const wrong = WRONG_RED.exec(message);
  if (wrong !== null) return `red for the wrong reason (${wrong[0]})`;
  if (RIGHT_RED.test(message)) return null;
  return 'red for an unrecognised reason (not an assertion, a counterexample or NotImplemented)';
}

/**
 * Checks a Vitest JSON report. `ruleTestGlobs` are the rule-test locations (class 1 of the
 * trusted protected-path list); files of the report outside them are ignored. `root` is
 * stripped from the absolute file names Vitest reports.
 */
export function checkRedReport(
  report: unknown,
  ruleTestGlobs: readonly string[],
  root: string,
): RedResult {
  const problems: RedProblem[] = [];
  const red: string[] = [];
  const files =
    typeof report === 'object' &&
    report !== null &&
    Array.isArray((report as { testResults?: unknown }).testResults)
      ? ((report as { testResults: unknown[] }).testResults as FileResult[])
      : null;
  if (files === null) {
    return {
      ok: false,
      red,
      problems: [{ file: '', test: null, reason: 'not a Vitest JSON report' }],
    };
  }
  const prefix = root.endsWith('/') ? root : `${root}/`;
  let ruleFiles = 0;
  for (const entry of files) {
    const abs = text(entry.name);
    const file = abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
    if (!matchesAny(file, ruleTestGlobs)) continue;
    ruleFiles += 1;
    const tests = Array.isArray(entry.assertionResults)
      ? (entry.assertionResults as AssertionResult[])
      : [];
    if (tests.length === 0) {
      // The file failed before any test ran (import error, syntax error) or has no test.
      const why = text(entry.message);
      problems.push({
        file,
        test: null,
        reason:
          why === ''
            ? 'no test ran in this rule-test file'
            : `the file did not load: ${wrongRedReason(why) ?? 'failed before any test ran'}`,
      });
      continue;
    }
    for (const t of tests) {
      const name = text(t.fullName) || text(t.title);
      const status = text(t.status);
      if (status === 'passed') {
        problems.push({ file, test: name, reason: 'green on the skeleton: the test has no teeth' });
        continue;
      }
      if (status !== 'failed') {
        problems.push({
          file,
          test: name,
          reason: `status "${status}" (skipped or todo is not red)`,
        });
        continue;
      }
      const messages = Array.isArray(t.failureMessages) ? t.failureMessages.map(text) : [];
      const why = wrongRedReason(messages.join('\n'));
      if (why === null) red.push(`${file} > ${name}`);
      else problems.push({ file, test: name, reason: why });
    }
  }
  if (ruleFiles === 0) {
    problems.push({ file: '', test: null, reason: 'the report holds no rule-test file' });
  }
  return { ok: problems.length === 0, red, problems };
}
