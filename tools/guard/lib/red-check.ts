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
//
// Browser tests (F1-01j; `*.browser.test.{ts,tsx}`, project spec-browser, Vitest browser mode in a
// real Chromium): red for an assertion, or because the element a test waits for never came, is a
// valid red (规划/11 §2.3 step 3). A wait is `expect.element(…)` / `expect.poll(…)`: when it runs
// out, vitest 5.0.1 rethrows its last error with an added innermost cause "Matcher did not succeed
// in time." (throwWithCause), so the innermost cause alone would refuse every such red. For the
// files the red reporter marks as run in a browser — and only there — browserCauseVerdict looks
// through that wrapper at the error it wraps: an AssertionError, a failed expect.element matcher
// (a `matcher` cause: jest-dom style matchers throw a plain Error), the locator error of an
// element that never appeared ("Cannot find element with locator", VitestBrowserElementError).
// The poll's own timeout ("expect.poll() function didn't resolve in time.") is what expect.element
// ends in when the wait runs out while the element lookup is still going, but also what any
// expect.poll whose function hangs ends in; it counts only when the wait can only have been
// expect.element: the failing call was made in the test file itself (`site`: the first stack frame
// outside the dependencies) and the file's code never uses `poll` (`poll_in_source`; comments and
// string literals do not count) — both recorded by the red reporter. Rule-test authors wait for
// elements with expect.element in the test file, never with expect.poll. A browser that did not
// start, an error thrown by the page, a module not found, a TypeError, a strict-mode violation
// (several elements) and a bare element lookup outside a wait stay invalid.
//
// Build smoke tests (F1-01k; `test/spec/**/*.smoke.test.ts`, project build-smoke: Node tests that
// open the entries the globalSetup built and serves, through the playwright library): red for an
// assertion, or because the element a test waits for never came — Playwright's TimeoutError of
// `locator.waitFor` ("locator.waitFor: Timeout <n>ms exceeded.") — is a valid red. Everything else
// stays invalid: a globalSetup that failed (a build, a server, the health check: no test runs), a
// browser that did not launch, a page.goto that failed or timed out, a `net::ERR_*`, any other
// Playwright timeout (screenshot, click …). A page that throws while rendering does not fail the
// test itself: Playwright only fires `pageerror`, the page stays blank and the wait runs out. The
// rule tests collect page events into an annotation whose JSON attachment is
// `{entry, url, diagnostics: [{kind, message}]}` (never asserted), and the red reporter keeps the
// annotations of every test. Before an assertion or a wait that ran out counts, the diagnostics
// are read: an error the page threw (`pageerror`; the skeleton's NotImplemented excepted), a
// request to the entry's own origin that failed (`requestfailed`; requests the test itself
// blocked excepted), a module of the page that did not load (`console.error` of a failed
// dynamic import) or a script error the page only logged (`console.error` carrying React
// Router's "caught the following error during render" — its errorElement catches a render error,
// so no `pageerror` fires — or naming a TypeError, ReferenceError, SyntaxError, RangeError …;
// the skeleton's NotImplemented excepted) make the red invalid. So do the errors a page swallows
// without either (F1-01m; the rule tests install a collector before any page script runs): a
// `preload-error` (Vite's `vite:preloadError`: a lazy chunk or a dependency that did not load or
// threw while initialising, e.g. a chunk served 200 whose module throws a TypeError), an
// `unhandled-rejection` (both with the skeleton's NotImplemented excepted), a `route-error` (the
// H5 route error page React Router's errorElement shows; excepted only when the same diagnostics
// carry the skeleton's NotImplemented that explains it) and a `diagnostics-incomplete` (the test
// could not read the page back: its events are not fully known). Only a page error whose first line starts with
// `NotImplemented` or `Error: NotImplemented` is the skeleton's (a TypeError, ReferenceError …
// mentioning it is not; those kinds are checked first, as on the Node side). A wait that ran out
// in a test without such an annotation is invalid (the page events are unknown); any other red of
// such a test is judged by its failure alone. Both are said in the result (`notes`). Smoke rule
// tests that open a page must write the annotation. On a green run the build-smoke project's
// strict reporter (tools/ops/build-smoke/strict-reporter.mjs) fails on the same page problems.
import { matchesAny } from '../../lib/glob.ts';
import type { Change } from '../../lib/git.ts';
import type { TaskFile } from '../../lib/task-file.ts';

/** True when the task must show red rule tests before it is implemented. */
export function redCheckRequired(task: Pick<TaskFile, 'tester'>): boolean {
  return task.tester !== 'none';
}

/** Test files that Vitest runs (the spec-tests package: unit and integration configs). */
export const RULE_TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

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
  /** Failures with their cause chains (red reporter only). */
  failures?: unknown;
  /** The test's annotations, JSON attachments parsed (red reporter only, F1-01k). */
  annotations?: unknown;
};
type FileResult = {
  name?: unknown;
  /** The file ran in a real browser (red reporter, F1-01j). */
  browser?: unknown;
  /** The file's source mentions `poll`, or could not be read (red reporter, F1-01j). */
  poll_in_source?: unknown;
  status?: unknown;
  message?: unknown;
  assertionResults?: unknown;
  failures?: unknown;
};

export type RedProblem = { file: string; test: string | null; reason: string };
export type RedResult = {
  ok: boolean;
  red: string[];
  problems: RedProblem[];
  /** How a valid red was judged when that is worth saying (a smoke test without diagnostics). */
  notes: string[];
};

/** Failures that prove nothing about the rule; checked first, they win over any wrapper. */
const WRONG_RED: [RegExp, string][] = [
  [
    /browserType\.launch|Executable doesn't exist|Failed to launch the browser|Browser connection was closed|did not respond to a heartbeat|Target page, context or browser has been closed/,
    'browser not running',
  ],
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
  [/\b(?:fixture|seeding)\b[^\n]*\b(?:failed|error)\b/i, 'fixture failed'],
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
const RETURNED_FALSE = /Property failed by returning false/;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export type Cause = {
  name: string;
  message: string;
  /** The expect.extend matcher that failed (red reporter; e.g. toBeVisible of expect.element). */
  matcher?: string;
};

/**
 * Why a failure is not a valid red, from its chain of causes (the red reporter keeps them:
 * tools/ops/verify-image/red-reporter.mjs), or null when it is one. The innermost cause decides:
 * an AssertionError, or the NotImplemented a skeleton throws. A property that merely returned
 * false shows no assertion and is refused; so is anything else (fail-closed, CR2-03).
 */
export function causeVerdict(causes: readonly Cause[]): string | null {
  const root = causes[causes.length - 1];
  if (root === undefined) return 'red for an unknown reason (the report carries no failure detail)';
  if (root.name === 'AssertionError') return null;
  const all = causes.map((c) => `${c.name}: ${c.message}`).join('\n');
  for (const [pattern, label] of WRONG_RED) {
    if (pattern.test(all)) return `red for the wrong reason (${label})`;
  }
  if (RETURNED_FALSE.test(root.message)) {
    return 'red for an unrecognised reason (the property returned false: assert with expect inside properties)';
  }
  if (/\bNotImplemented\b/.test(root.message) || /\bNotImplemented\b/.test(root.name)) return null;
  return `red for an unrecognised reason (${root.name}: not an assertion or NotImplemented)`;
}

/**
 * Why a failure message (a plain Vitest JSON report, without causes) is not a valid red, or null
 * when it is one. A fast-check failure counts only when the message itself shows an assertion or
 * NotImplemented under "Got error"; Vitest's own JSON reporter drops the cause, so a property
 * failure there is refused (CR2-03).
 */
export function wrongRedReason(message: string): string | null {
  for (const [pattern, label] of WRONG_RED) {
    if (pattern.test(message)) return `red for the wrong reason (${label})`;
  }
  if (PROPERTY.test(message)) {
    const at = message.search(/Got (?:an )?error/);
    const cause = at < 0 ? '' : message.slice(at);
    if (cause !== '' && RIGHT_CAUSE.test(cause)) return null;
    return 'red for an unrecognised reason (the property failure shows no underlying assertion: run it through verify-container.sh --red)';
  }
  if (RIGHT_CAUSE.test(message)) return null;
  return 'red for an unrecognised reason (not an assertion, a counterexample or NotImplemented)';
}

/** Build smoke rule-test files: the build-smoke project (red-projects.json, F1-01k). */
export const SMOKE_TEST_FILE = /\.smoke\.test\.[cm]?[jt]sx?$/;

/** Failures of a build smoke test that prove nothing about the page under test. */
const SMOKE_WRONG_RED: [RegExp, string][] = [
  [/\bnet::ERR_[A-Z_]+/, 'page did not load (net::ERR_*)'],
  [/\bpage\.goto:/, 'page did not load (page.goto failed)'],
  [/\bbrowserType\.launch\b|\bchromium\.launch\b/, 'browser not running'],
];

/** The message of the TimeoutError Playwright throws when locator.waitFor runs out. */
const LOCATOR_WAIT_RAN_OUT = /^locator\.waitFor: Timeout \d+ms exceeded\./;

/**
 * Verdict of a failure of a build smoke rule test (see the header): an AssertionError, or the
 * TimeoutError of a locator.waitFor whose element never came, is a valid red; a page that did not
 * load, a browser that did not launch, and everything causeVerdict refuses are not.
 */
export function smokeCauseVerdict(causes: readonly Cause[]): string | null {
  const all = causes.map((c) => `${c.name}: ${c.message}`).join('\n');
  for (const [pattern, label] of SMOKE_WRONG_RED) {
    if (pattern.test(all)) return `red for the wrong reason (${label})`;
  }
  const root = causes[causes.length - 1];
  if (
    root?.name === 'TimeoutError' &&
    causes.length === 1 &&
    LOCATOR_WAIT_RAN_OUT.test(root.message)
  ) {
    return null;
  }
  if (root?.name === 'TimeoutError') {
    return `red for the wrong reason (a Playwright timeout outside locator.waitFor: ${root.message.split('\n')[0] ?? ''})`;
  }
  return causeVerdict(causes);
}

/** True when a failure of the test is the TimeoutError of a locator.waitFor (red reporter causes). */
function waitedForAnElement(failures: unknown): boolean {
  if (!Array.isArray(failures)) return false;
  return (failures as Failure[]).some((f) => {
    const causes = causesOf(f);
    const root = causes[causes.length - 1];
    return root?.name === 'TimeoutError' && LOCATOR_WAIT_RAN_OUT.test(root.message);
  });
}

/** The page events a build smoke test collected for one entry (its diagnostics annotation). */
export type SmokeDiagnostics = {
  url: string;
  diagnostics: { kind: string; message: string }[];
};

/**
 * The diagnostics annotations of a test of the red report: every annotation whose JSON
 * attachment has a `diagnostics` array (the build smoke rule tests write one per entry they open).
 */
export function smokeDiagnosticsOf(annotations: unknown): SmokeDiagnostics[] {
  if (!Array.isArray(annotations)) return [];
  const out: SmokeDiagnostics[] = [];
  for (const a of annotations) {
    if (typeof a !== 'object' || a === null) continue;
    const json = (a as Record<string, unknown>)['json'];
    if (typeof json !== 'object' || json === null) continue;
    const list = (json as Record<string, unknown>)['diagnostics'];
    if (!Array.isArray(list)) continue;
    out.push({
      url: text((json as Record<string, unknown>)['url']),
      diagnostics: list.map((d) => {
        const r = (typeof d === 'object' && d !== null ? d : {}) as Record<string, unknown>;
        return { kind: text(r['kind']), message: text(r['message']) };
      }),
    });
  }
  return out;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** A failed dynamic import, as the browser logs it (Chromium and others). */
const MODULE_DID_NOT_LOAD =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/;

/**
 * True when the first line of an error the page threw is the skeleton's NotImplemented: it starts
 * with `NotImplemented` (the skeleton's own error class) or `Error: NotImplemented` (a plain Error
 * with that message). A TypeError, ReferenceError … that merely mentions NotImplemented does not
 * count: as on the Node side (causeVerdict), those kinds are checked first.
 */
export function skeletonPageError(first: string): boolean {
  for (const [pattern] of WRONG_RED) {
    if (pattern.test(first)) return false;
  }
  return /^(?:Error: )?NotImplemented\b/.test(first);
}

/**
 * The prefix React Router (and its <Await>) logs before an error its error boundary caught while
 * rendering: `console.error("React Router caught the following error during render", error)`,
 * which Playwright reads as that text, a space, then the error's stack.
 */
const CAUGHT_DURING_RENDER = /^.*?caught the following error during render\s*/;
/** Error kinds of a script fault, as a console.error of the page names them. */
const SCRIPT_ERROR_KIND =
  /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError|InternalError|AggregateError)\b/;

/**
 * True when a `console.error` of the page reports a script fault (Codex review r3, S1 ②): an
 * error an error boundary caught while rendering (React Router's errorElement swallows it, no
 * `pageerror` fires, the page shows its error screen and the wait runs out), or any message
 * naming a TypeError, ReferenceError, SyntaxError, RangeError …. With `skeleton` the skeleton's
 * NotImplemented is excepted: the first line of the error itself (after React Router's prefix)
 * starts with `NotImplemented` or `Error: NotImplemented` (skeletonPageError).
 */
export function scriptFaultConsoleError(message: string, skeleton: boolean): boolean {
  const first = message.split('\n')[0] ?? '';
  if (!CAUGHT_DURING_RENDER.test(first) && !SCRIPT_ERROR_KIND.test(message)) return false;
  return !(skeleton && skeletonPageError(first.replace(CAUGHT_DURING_RENDER, '')));
}

/**
 * True when the diagnostics of one entry carry the skeleton's NotImplemented (an error the page
 * threw, an error an error boundary caught while rendering, a failed lazy module or an unhandled
 * rejection whose first line is the skeleton's): the one thing that excuses a `route-error`.
 */
function skeletonExplains(diagnostics: SmokeDiagnostics['diagnostics']): boolean {
  return diagnostics.some((x) => {
    const first = x.message.split('\n')[0] ?? '';
    if (['pageerror', 'preload-error', 'unhandled-rejection'].includes(x.kind)) {
      return skeletonPageError(first);
    }
    return (
      x.kind === 'console.error' &&
      CAUGHT_DURING_RENDER.test(first) &&
      !scriptFaultConsoleError(x.message, true)
    );
  });
}

/**
 * Why the page events of one entry make a red invalid (see the header), or null when they do
 * not: an error the page threw other than the skeleton's NotImplemented, a request to the entry's
 * own origin that failed and that the test did not block itself (a `blocked-request` of the same
 * URL), a dynamic import that failed, a script error the page only logged
 * (scriptFaultConsoleError), and what the page swallowed (F1-01m): a lazy module that failed
 * (`preload-error`) or an unhandled rejection, both other than the skeleton's NotImplemented, the
 * route error page unless the skeleton's NotImplemented explains it (skeletonExplains), and
 * diagnostics the test could not read back (`diagnostics-incomplete`). A URL that cannot be read
 * counts as the entry's own.
 */
export function smokeDiagnosticsVerdict(d: SmokeDiagnostics): string | null {
  const own = originOf(d.url);
  const blocked = new Set(
    d.diagnostics.filter((x) => x.kind === 'blocked-request').map((x) => x.message),
  );
  for (const x of d.diagnostics) {
    const first = x.message.split('\n')[0] ?? '';
    if (x.kind === 'pageerror' && !skeletonPageError(first)) {
      return `red for the wrong reason (the page threw: ${first})`;
    }
    if (x.kind === 'preload-error' && !skeletonPageError(first)) {
      return `red for the wrong reason (a lazy module of the page failed: ${first})`;
    }
    if (x.kind === 'unhandled-rejection' && !skeletonPageError(first)) {
      return `red for the wrong reason (the page left a rejection unhandled: ${first})`;
    }
    if (x.kind === 'route-error' && !skeletonExplains(d.diagnostics)) {
      return `red for the wrong reason (the page showed its route error page: ${first})`;
    }
    if (x.kind === 'diagnostics-incomplete') {
      return `red for an unproven reason (the page events are not fully known: ${first})`;
    }
    if (x.kind === 'requestfailed') {
      // "<url>: <errorText>" (the rule tests' format)
      const at = x.message.lastIndexOf(': ');
      const url = at < 0 ? x.message : x.message.slice(0, at);
      if (blocked.has(url)) continue;
      const origin = originOf(url);
      if (own === null || origin === null || origin === own) {
        return `red for the wrong reason (a request of the entry failed: ${first})`;
      }
    }
    if (x.kind === 'console.error' && MODULE_DID_NOT_LOAD.test(x.message)) {
      return `red for the wrong reason (a module of the page did not load: ${first})`;
    }
    if (x.kind === 'console.error' && scriptFaultConsoleError(x.message, true)) {
      return `red for the wrong reason (the page logged a script error: ${first})`;
    }
  }
  return null;
}

/** Browser rule-test files: the spec-browser project (tools/ops/verify-image/red-projects.json). */
export const BROWSER_TEST_FILE = /\.browser\.test\.[cm]?[jt]sx?$/;

/** The cause vitest 5.0.1 adds when an expect.poll / expect.element wait runs out. */
const WAIT_RAN_OUT = 'Matcher did not succeed in time.';
/** expect.poll's own timeout while the polled function (the element lookup) was still running. */
const LOOKUP_STILL_WAITING = "expect.poll() function didn't resolve in time.";
/** The error of a locator whose element never appeared (@vitest/browser getElementError). */
const ELEMENT_NOT_FOUND = 'Cannot find element with locator: ';

/** What a browser wait may wrap for its red to count: an assertion, or an element never seen. */
function waitedForTheRightThing(c: Cause): boolean {
  if (c.name === 'AssertionError') return true;
  if (c.matcher !== undefined && c.matcher !== '') return true;
  return c.name === 'VitestBrowserElementError' && c.message.startsWith(ELEMENT_NOT_FOUND);
}

export type BrowserWait = {
  /**
   * The wait can only have been expect.element: the failing call was made in the test file
   * itself and that file never mentions `poll` (see the header).
   */
  elementOnly: boolean;
};

/**
 * Verdict of a failure of a browser rule test (see the header): an expect.element / expect.poll
 * wait that ran out counts when what it waited for was an assertion or an element; the poll's own
 * timeout counts only for a wait that can only have been expect.element; a failed matcher counts
 * like an assertion. Everything else is judged by causeVerdict.
 */
export function browserCauseVerdict(
  causes: readonly Cause[],
  wait: BrowserWait = { elementOnly: false },
): string | null {
  const root = causes[causes.length - 1];
  if (root === undefined) return causeVerdict(causes);
  if (root.name === 'Error' && root.message === WAIT_RAN_OUT && causes.length >= 2) {
    const waited = causes[causes.length - 2];
    if (waited !== undefined && waitedForTheRightThing(waited)) return null;
    if (waited?.name === 'Error' && waited.message === LOOKUP_STILL_WAITING) {
      if (wait.elementOnly) return null;
      return (
        'red for an unrecognised reason (an expect.poll timed out and nothing shows it waited ' +
        'for an element: wait with expect.element in the test file itself, never expect.poll)'
      );
    }
    return causeVerdict(causes.slice(0, -1));
  }
  if (root.matcher !== undefined && root.matcher !== '') return null;
  return causeVerdict(causes);
}

/**
 * True when `site` (the first parsed stack frame the red reporter recorded) is the test file
 * `abs`: the same absolute path (also behind the browser's http://localhost:<port>, as `file://`
 * or Vite's `/@fs` URL), or the URL path below the test package (`/spec/…`), without a query.
 * The red reporter already records the first frame outside the dependencies, normalised.
 */
function siteIsFile(site: unknown, abs: string): boolean {
  if (typeof site !== 'object' || site === null) return false;
  const raw = text((site as Record<string, unknown>)['file']);
  const file = raw
    .replace(/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?=\/)/, '')
    .replace(/^file:\/\//, '')
    .replace(/^\/@fs(?=\/)/, '')
    .replace(/[?#].*$/, '');
  if (file === '' || abs === '') return false;
  return file === abs || (file.startsWith('/spec/') && abs.endsWith(`/test${file}`));
}

type Failure = { causes?: unknown; site?: unknown };

function causesOf(failure: Failure): Cause[] {
  return Array.isArray(failure.causes)
    ? failure.causes.map((c) => {
        const r = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
        const cause: Cause = { name: text(r['name']), message: text(r['message']) };
        const matcher = text(r['matcher']);
        if (matcher !== '') cause.matcher = matcher;
        return cause;
      })
    : [];
}

/** How a browser file of the report is read: null for every other file. */
type BrowserFile = { abs: string; pollFree: boolean } | null;

/** Verdict of one failed test: structured causes when the report has them, else the messages. */
function testVerdict(
  failures: unknown,
  messages: string[],
  browser: BrowserFile,
  smoke: boolean,
): string | null {
  if (Array.isArray(failures)) {
    if (failures.length === 0)
      return 'red for an unknown reason (the report carries no failure detail)';
    for (const f of failures as Failure[]) {
      const why =
        browser !== null
          ? browserCauseVerdict(causesOf(f), {
              elementOnly: browser.pollFree && siteIsFile(f.site, browser.abs),
            })
          : smoke
            ? smokeCauseVerdict(causesOf(f))
            : causeVerdict(causesOf(f));
      if (why !== null) return why;
    }
    return null;
  }
  return wrongRedReason(messages.join('\n'));
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
  const notes: string[] = [];
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
    // Errors outside any test (an unhandled rejection, a crashed worker) taint the whole run.
    const unhandled = (report as { unhandledErrors?: unknown }).unhandledErrors;
    if (Array.isArray(unhandled) && unhandled.length > 0) {
      const why =
        causeVerdict(causesOf(unhandled[0] as Failure)) ?? 'an assertion outside any test';
      problems.push({ file: '', test: null, reason: `the run had unhandled errors: ${why}` });
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
    // Browser leniency only for a browser rule-test file that the red reporter saw run in a
    // browser; Vitest's own JSON report (no `browser`, no causes) never gets it.
    const browser: BrowserFile =
      entry.browser === true && BROWSER_TEST_FILE.test(file)
        ? { abs: text(entry.name), pollFree: entry.poll_in_source === false }
        : null;
    // Build smoke leniency (locator.waitFor) only for a build smoke rule-test file of the
    // build-smoke project (test/spec/**/*.smoke.test.ts, red-projects.json) that ran in Node (not
    // in a browser), and only from the red reporter's causes; the plain messages of Vitest's JSON
    // report never get it.
    const smoke =
      entry.browser !== true && file.startsWith('test/spec/') && SMOKE_TEST_FILE.test(file);
    // File-level errors (an import that failed, a crashed beforeAll / afterAll) are never a valid
    // red: they taint every test of the file.
    const fileFailures = Array.isArray(entry.failures) ? (entry.failures as Failure[]) : [];
    const fileWhy = text(entry.message);
    const fileWrong =
      fileFailures.length > 0
        ? (causeVerdict(causesOf(fileFailures[0] as Failure)) ??
          'an error outside the tests of this file')
        : fileWhy === ''
          ? null
          : (wrongRedReason(fileWhy) ?? 'an error outside the tests of this file');
    if (tests.length === 0) {
      problems.push({
        file,
        test: null,
        reason:
          fileWrong === null
            ? 'no test ran in this rule-test file'
            : `the file did not load: ${fileWrong}`,
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
          reason: `status "${status}" (skipped, todo or pending is not red)`,
        });
        continue;
      }
      const messages = Array.isArray(t.failureMessages) ? t.failureMessages.map(text) : [];
      let why = fileWrong ?? testVerdict(t.failures, messages, browser, smoke);
      if (why === null && smoke) {
        // The page events the test collected decide before its red counts (see the header).
        const diagnostics = smokeDiagnosticsOf(t.annotations);
        for (const d of diagnostics) {
          why = smokeDiagnosticsVerdict(d);
          if (why !== null) break;
        }
        if (why === null && diagnostics.length === 0) {
          if (waitedForAnElement(t.failures)) {
            // A wait that ran out says nothing without the page events: the page may have thrown.
            why =
              'red for an unproven reason (locator.waitFor ran out but the test wrote no browser diagnostics annotation)';
            notes.push(
              `${file} > ${name}: locator.waitFor timeout without browser diagnostics, judged invalid`,
            );
          } else {
            notes.push(
              `${file} > ${name}: no browser diagnostics in the report, judged by the failure alone`,
            );
          }
        }
      }
      if (why === null) red.push(`${file} > ${name}`);
      else problems.push({ file, test: name, reason: why });
    }
  }
  return { ok: problems.length === 0, red, problems, notes };
}
