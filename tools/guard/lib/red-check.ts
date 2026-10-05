// Red check of the rule tests (规划/11 §2.3 step 3): before the implementation, every rule test the
// task added must have run and be red, and red for the right reason — an assertion failure, a
// fast-check counterexample whose cause is an assertion (or a predicate that returned false), or
// the NotImplemented a skeleton throws. Red because a module is missing, a TypeError, a database
// that cannot be reached, a migration or fixture that failed, a server that is not up or a build
// that failed does not count: such a test has not been shown to have teeth. A wrapper (fast-check's
// "Property failed … Got error: …", a hook failure) never makes such a cause count (CR-11).
//
// Scope (default split of 2026-10-05, ops/approvals.yaml id 19; 规划/11 §2.3 step 3): every task
// that has a rule-test author (ledger `tester` is not `none`), at every risk level.
//
// Reconciliation (CR-10): the report is checked against the list of rule-test files the task
// added or changed (inside its `test_paths`); a file of that list that is missing from the report,
// ran no test, or has a skipped / todo / pending test fails the check.
//
// Input is the Vitest JSON report (`vitest run --reporter=json`) of the isolated red run
// (tools/ops/verify-container.sh --red): those tests are Codex-written and never run on the host.
// Browser tests (Playwright) are not covered here yet.
import { matchesAny } from '../../lib/glob.ts';
import type { Change } from '../../lib/git.ts';
import type { TaskFile } from '../../lib/task-file.ts';

/** True when the task must show red rule tests before it is implemented. */
export function redCheckRequired(task: Pick<TaskFile, 'tester'>): boolean {
  return task.tester !== 'none';
}

/** Test files that Vitest runs (the spec-tests package: unit and integration configs). */
export const RULE_TEST_FILE = /\.test\.[cm]?[jt]s$/;

/**
 * The rule-test files a task added or changed: inside its test_paths and named like a test.
 * Removed files are not expected (and are refused by the add-only guard anyway).
 */
export function expectedRuleTests(
  changes: readonly Change[],
  testPaths: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const c of changes) {
    if (c.status === 'D') continue;
    if (RULE_TEST_FILE.test(c.path) && matchesAny(c.path, testPaths)) out.add(c.path);
  }
  return [...out].sort();
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

/** Failures that prove nothing about the rule; checked first, they win over any wrapper. */
const WRONG_RED: [RegExp, string][] = [
  [
    /Cannot find (?:module|package)|Failed to load url|Failed to resolve import|ERR_MODULE_NOT_FOUND/,
    'module not found',
  ],
  [/\bTypeError\b/, 'TypeError'],
  [/\bReferenceError\b/, 'ReferenceError'],
  [/\bSyntaxError\b/, 'SyntaxError'],
  [/\bRangeError: Maximum call stack/, 'stack overflow'],
  [
    /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN|getaddrinfo/,
    'network or database unreachable',
  ],
  [
    /connection terminated|Connection terminated|password authentication failed|database "[^"]*" does not exist|role "[^"]*" does not exist|too many clients/i,
    'database connection failed',
  ],
  [/TEST_PG_ADMIN_URL/, 'test database not configured'],
  [/migrat(?:e|ion)[^\n]*(?:fail|error)|(?:fail|error)[^\n]*migrat(?:e|ion)/i, 'migration failed'],
  [/(?:fixture|seed)[^\n]*(?:fail|error)/i, 'fixture failed'],
  [/Hook timed out|beforeAll|beforeEach|globalSetup|setupFiles/, 'test setup failed'],
  [/Test timed out/, 'timed out'],
  [
    /EADDRINUSE|server (?:is )?not (?:up|running|ready)|listen E[A-Z]+|health ?check/i,
    'server not up',
  ],
  [
    /[Bb]uild failed|Transform failed|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|Unexpected token/,
    'build failed',
  ],
  [/\bENOENT\b|\bEACCES\b|\bEPERM\b/, 'file system error'],
];
/** What counts: an assertion, the skeleton's NotImplemented. */
const RIGHT_CAUSE = /AssertionError|\bexpected\b[\s\S]*\bto\b|\bNotImplemented\b/;
const PROPERTY = /Property failed after/;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Why a failure message is not a valid red, or null when it is one. */
export function wrongRedReason(message: string): string | null {
  for (const [pattern, label] of WRONG_RED) {
    if (pattern.test(message)) return `red for the wrong reason (${label})`;
  }
  if (PROPERTY.test(message)) {
    // A counterexample counts when the property returned false (no error) or its error is an
    // assertion / NotImplemented; the wrapper text alone proves nothing.
    const at = message.search(/Got (?:an )?error/);
    const cause = at < 0 ? undefined : message.slice(at);
    if (cause === undefined || RIGHT_CAUSE.test(cause)) return null;
    return 'red for an unrecognised reason (the counterexample is not an assertion failure)';
  }
  if (RIGHT_CAUSE.test(message)) return null;
  return 'red for an unrecognised reason (not an assertion, a counterexample or NotImplemented)';
}

/**
 * Checks Vitest JSON reports against the expected rule-test files (repository-relative). `root`
 * is stripped from the absolute file names Vitest reports.
 */
export function checkRedReports(
  reports: readonly unknown[],
  expected: readonly string[],
  root: string,
): RedResult {
  const problems: RedProblem[] = [];
  const red: string[] = [];
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const seen = new Map<string, FileResult>();
  for (const report of reports) {
    const files =
      typeof report === 'object' &&
      report !== null &&
      Array.isArray((report as { testResults?: unknown }).testResults)
        ? ((report as { testResults: unknown[] }).testResults as FileResult[])
        : null;
    if (files === null) {
      problems.push({ file: '', test: null, reason: 'not a Vitest JSON report' });
      continue;
    }
    for (const entry of files) {
      const abs = text(entry.name);
      seen.set(abs.startsWith(prefix) ? abs.slice(prefix.length) : abs, entry);
    }
  }
  if (expected.length === 0) {
    problems.push({ file: '', test: null, reason: 'the task added no rule-test file to check' });
  }
  for (const file of expected) {
    const entry = seen.get(file);
    if (entry === undefined) {
      problems.push({
        file,
        test: null,
        reason: 'not in the report: this rule-test file did not run',
      });
      continue;
    }
    const tests = Array.isArray(entry.assertionResults)
      ? (entry.assertionResults as AssertionResult[])
      : [];
    if (tests.length === 0) {
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
    // A file-level error next to failing tests (a failed afterAll, a crashed setup) taints them.
    const fileWhy = text(entry.message);
    const fileWrong = fileWhy === '' ? null : wrongRedReason(fileWhy);
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
          reason: `status "${status}" (skipped, todo or pending is not red)`,
        });
        continue;
      }
      const messages = Array.isArray(t.failureMessages) ? t.failureMessages.map(text) : [];
      const why = wrongRedReason(messages.join('\n')) ?? fileWrong;
      if (why === null) red.push(`${file} > ${name}`);
      else problems.push({ file, test: name, reason: why });
    }
  }
  return { ok: problems.length === 0, red, problems };
}
