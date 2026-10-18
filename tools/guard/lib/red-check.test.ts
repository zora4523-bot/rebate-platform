// Unit tests of the red check (规划/11 §2.3 step 3; ops/approvals.yaml id 19; Codex review
// CR-10, CR-11 of 2026-10-05).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { Change } from '../../lib/git.ts';
import {
  type BaselineReader,
  browserCauseVerdict,
  causeVerdict,
  checkRedReports,
  expectedRuleTests,
  redCheckRequired,
  ruleTestBaselines,
  scriptFaultConsoleError,
  smokeCauseVerdict,
  smokeDiagnosticsOf,
  smokeDiagnosticsVerdict,
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
    notes: [],
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

const B = 'test/spec/zzbrowser/b.browser.test.ts';
const LAUNCH = 'test/spec/zzbrowser/launch.browser.test.ts';
const WAIT = { name: 'Error', message: 'Matcher did not succeed in time.' };
const UNRECOGNISED = 'red for an unrecognised reason (Error: not an assertion or NotImplemented)';
const POLL = 'test/spec/zzbrowser/poll.browser.test.ts';
const POLL_REFUSED =
  'red for an unrecognised reason (an expect.poll timed out and nothing shows it waited for an ' +
  'element: wait with expect.element in the test file itself, never expect.poll)';

it('[F1-01j] browser rule tests: an assertion, or an element waited for that never came, is a valid red', () => {
  // Shapes of vitest 5.0.1 / @vitest/browser 5.0.1 / playwright-core 1.63.0 failures in the form
  // the red reporter writes; where each one comes from is noted in the fixture ("//").
  const result = checkRedReports([fixture('browser-report.json')], [B, LAUNCH, POLL], ROOT);
  expect(result.red).toEqual([
    `${B} > [AC-B#1] element never appears: locator error`,
    `${B} > [AC-B#2] element never appears: lookup still waiting`,
    `${B} > [AC-B#3] expect.element matcher fails`,
    `${B} > [AC-B#4] expect.poll assertion fails`,
    `${B} > [AC-B#5] plain assertion`,
    `${B} > [AC-B#6] matcher without a wait`,
    `${B} > [AC-B#16] lookup still waiting, site as the browser URL`,
  ]);
  expect(result.problems.map((p) => `${p.test ?? p.file}: ${p.reason}`)).toEqual([
    '[AC-B#7] TypeError inside the wait: red for the wrong reason (TypeError)',
    `[AC-B#8] several elements (strict mode): ${UNRECOGNISED}`,
    '[AC-B#9] element lookup outside a wait: red for an unrecognised reason ' +
      '(VitestBrowserElementError: not an assertion or NotImplemented)',
    `[AC-B#10] the polled assertion hangs: ${UNRECOGNISED}`,
    '[AC-B#11] test timed out: red for the wrong reason (timed out)',
    `[AC-B#12] page error inside the wait: ${UNRECOGNISED}`,
    '[AC-B#13] skipped: status "skipped" (skipped, todo or pending is not red)',
    // The poll's own timeout counts only for a wait started in the test file (B#2, B#16) of a
    // file that never mentions poll: not from a helper, not without a stack frame, not in a file
    // that uses expect.poll (a hung expect.poll looks exactly like this).
    `[AC-B#14] lookup still waiting, wait started in a helper: ${POLL_REFUSED}`,
    `[AC-B#15] lookup still waiting, no stack frame: ${POLL_REFUSED}`,
    `${LAUNCH}: the file did not load: red for the wrong reason (browser not running)`,
    `[AC-P#1] hung expect.poll: ${POLL_REFUSED}`,
  ]);
});

it('[F1-01j] the browser reading applies only to browser files the red reporter saw run in a browser', () => {
  const report = fixture('browser-report.json') as {
    testResults: Array<{ name: string; browser?: boolean }>;
  };
  // Not marked as run in a browser (a node project, or Vitest's own JSON report): the innermost
  // cause decides, as for every other rule test, so only the bare assertion is red.
  const unmarked = {
    ...report,
    testResults: report.testResults.map((entry) => ({ ...entry, browser: false })),
  };
  const plain = checkRedReports([unmarked], [B, LAUNCH], ROOT);
  expect(plain.red).toEqual([`${B} > [AC-B#5] plain assertion`]);
  const waited = [
    '[AC-B#1] element never appears: locator error',
    '[AC-B#4] expect.poll assertion fails',
  ];
  for (const title of waited) {
    expect(plain.problems.find((p) => p.test === title)?.reason).toBe(UNRECOGNISED);
  }
  // A file that is not a browser test file never gets it, marked or not.
  const nodeFile = B.replace('.browser.test.ts', '.test.ts');
  const renamed = {
    ...report,
    testResults: report.testResults.map((entry) => ({
      ...entry,
      name: entry.name.replace('.browser.test.ts', '.test.ts'),
    })),
  };
  const notBrowser = checkRedReports([renamed], [nodeFile], ROOT);
  expect(notBrowser.red).toEqual([`${nodeFile} > [AC-B#5] plain assertion`]);
});

it('[F1-01j] browserCauseVerdict looks through the wait only, at an assertion or a missing element', () => {
  const notFound = {
    name: 'VitestBrowserElementError',
    message: "Cannot find element with locator: getByText('x')",
  };
  const stillWaiting = { name: 'Error', message: "expect.poll() function didn't resolve in time." };
  expect(browserCauseVerdict([notFound, WAIT])).toBeNull();
  // The poll's own timeout: only for a wait that can only have been expect.element.
  expect(browserCauseVerdict([stillWaiting, WAIT], { elementOnly: true })).toBeNull();
  expect(browserCauseVerdict([stillWaiting, WAIT], { elementOnly: false })).toBe(POLL_REFUSED);
  expect(browserCauseVerdict([stillWaiting, WAIT])).toBe(POLL_REFUSED);
  const assertion = { name: 'AssertionError', message: 'expected 1 to be 2' };
  expect(browserCauseVerdict([assertion, WAIT])).toBeNull();
  const matcher = { name: 'Error', message: 'x', matcher: 'toBeVisible' };
  expect(browserCauseVerdict([matcher, WAIT])).toBeNull();
  // An outer wrapper does not change what the wait wrapped.
  const property = { name: 'Error', message: 'Property failed after 1 tests' };
  expect(browserCauseVerdict([property, notFound, WAIT])).toBeNull();
  // The wait alone, a wrapped TypeError, a locator message under another error name.
  expect(browserCauseVerdict([WAIT])).toBe(UNRECOGNISED);
  const typeError = { name: 'TypeError', message: 'Failed to fetch' };
  expect(browserCauseVerdict([typeError, WAIT])).toBe('red for the wrong reason (TypeError)');
  const renamed = { name: 'Error', message: notFound.message };
  expect(browserCauseVerdict([renamed, WAIT])).toBe(UNRECOGNISED);
  expect(browserCauseVerdict([])).toContain('no failure detail');
  // Outside the browser reading nothing changes: the wait's own cause is not an assertion.
  expect(causeVerdict([notFound, WAIT])).toBe(UNRECOGNISED);
  // .tsx rule tests (browser component tests) are expected like .ts ones.
  const tsx = 'test/spec/frontend/card.browser.test.tsx';
  expect(expectedRuleTests([{ path: tsx, status: 'A' }], ['test/spec/**'])).toEqual([tsx]);
  // A browser that could not start or went away: never a valid red, wherever it shows up.
  const closed = { name: 'Error', message: 'Target page, context or browser has been closed' };
  const notRunning = 'red for the wrong reason (browser not running)';
  expect(causeVerdict([closed])).toBe(notRunning);
  expect(browserCauseVerdict([closed, WAIT])).toBe(notRunning);
});

const DEMO = 'test/spec/frontend/browser-env/demo-red.browser.test.ts';

it('[F1-01j] real browser red runs: a missing element and an assertion are red, a TypeError is not', () => {
  // F1-01j red/1 and red/2 on the candidate copy (2026-10-06), see the fixtures' "//".
  const valid = checkRedReports([fixture('browser-red-1.json')], [DEMO], ROOT);
  expect(valid).toEqual({
    ok: true,
    red: [
      `${DEMO} > [demo] waits for an element that never appears`,
      `${DEMO} > [demo] plain assertion fails`,
    ],
    problems: [],
    notes: [],
  });
  const typeError = checkRedReports([fixture('browser-red-2.json')], [DEMO], ROOT);
  expect(typeError.ok).toBe(false);
  expect(typeError.problems).toEqual([
    {
      file: DEMO,
      test: '[demo] fails with a TypeError',
      reason: 'red for the wrong reason (TypeError)',
    },
  ]);
});

it('[F1-01j] the poll timeout of the real run counts only with the test file as its site', () => {
  type Entry = {
    poll_in_source: boolean;
    assertionResults: Array<{ failures: Array<{ causes: unknown; site: unknown }> }>;
  };
  // The real missing-element test, as if the poll timer had won the race (the other shape
  // expect.element ends in), with the site the current reporter would record.
  function variant(site: unknown, pollInSource = false): unknown {
    const report = fixture('browser-red-1.json') as { testResults: Entry[] };
    const entry = report.testResults[0];
    const failure = entry?.assertionResults[0]?.failures[0];
    if (entry === undefined || failure === undefined) throw new Error('fixture changed');
    entry.poll_in_source = pollInSource;
    failure.causes = [
      { name: 'Error', message: "expect.poll() function didn't resolve in time." },
      WAIT,
    ];
    failure.site = site;
    return report;
  }
  const missing = `${DEMO} > [demo] waits for an element that never appears`;
  const abs = `${ROOT}/${DEMO}`;
  // The test-file frame of the real stack: normalised by the reporter, or still as the browser URL.
  for (const file of [abs, `http://localhost:63315${abs}?import&browserv=1791261813481`]) {
    const result = checkRedReports([variant({ file, line: 8, column: 68 })], [DEMO], ROOT);
    expect(result.red, file).toContain(missing);
  }
  // What the round-2 reporter recorded (Vite's pre-bundled poll frame), no site, or a file that
  // uses expect.poll: refused.
  const deps =
    '/work/repo/test/node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/deps/' +
    'index.m3L2HgmY-ClFbRdXj.js?v=b6c384b3';
  for (const report of [
    variant({ file: deps, line: 5767, column: 47 }),
    variant(null),
    variant({ file: abs, line: 8, column: 68 }, true),
  ]) {
    const result = checkRedReports([report], [DEMO], ROOT);
    expect(result.red).not.toContain(missing);
    expect(result.problems.map((p) => p.reason)).toEqual([POLL_REFUSED]);
  }
});

const SMOKE = 'test/spec/frontend/build-smoke/entries.smoke.test.ts';

it('[F1-01k] build smoke rule tests: an assertion, or a locator.waitFor that ran out, is a valid red', () => {
  const result = checkRedReports([fixture('smoke-report.json')], [SMOKE], ROOT);
  expect(result.ok).toBe(false);
  // The wait counts: the page's only error is the skeleton's NotImplemented, and its failed
  // requests are the ones the test blocked itself (the admin permission endpoint, another host).
  // The skeleton's NotImplemented caught by React Router's errorElement (a console.error only)
  // still counts (orchestrator's ruling on S1 ①).
  expect(result.red).toEqual([
    `${SMOKE} > [demo] element never came`,
    `${SMOKE} > [demo] assertion`,
    `${SMOKE} > [demo] skeleton caught by errorElement`,
  ]);
  expect(result.problems.map((p) => [p.test, p.reason])).toEqual([
    [
      '[demo] page threw',
      "red for the wrong reason (the page threw: TypeError: Cannot read properties of undefined (reading 'routes'))",
    ],
    // A render error React Router's errorElement caught fires no pageerror (Codex r3, S1 ②).
    [
      '[demo] render error caught by errorElement',
      "red for the wrong reason (the page logged a script error: React Router caught the following error during render TypeError: Cannot read properties of undefined (reading 'map'))",
    ],
    [
      '[demo] chunk did not load',
      'red for the wrong reason (a request of the entry failed: http://127.0.0.1:40125/assets/page-D5e6.js: net::ERR_FAILED)',
    ],
    ['[demo] goto timed out', 'red for the wrong reason (page did not load (page.goto failed))'],
    ['[demo] connection refused', 'red for the wrong reason (page did not load (net::ERR_*))'],
    ['[demo] no browser', 'red for the wrong reason (browser not running)'],
    [
      '[demo] screenshot timed out',
      'red for the wrong reason (a Playwright timeout outside locator.waitFor: page.screenshot: Timeout 10000ms exceeded.)',
    ],
    ['[demo] test code threw', 'red for the wrong reason (TypeError)'],
  ]);
  // The size budget opens no page: no diagnostics, judged by the assertion alone, and said so.
  expect(result.notes).toEqual([
    `${SMOKE} > [demo] assertion: no browser diagnostics in the report, judged by the failure alone`,
  ]);
});

it('[F1-01k] smokeDiagnosticsVerdict: page errors, own failed requests and failed imports refuse a red', () => {
  const url = 'http://127.0.0.1:40123/';
  const v = (diagnostics: { kind: string; message: string }[]): string | null =>
    smokeDiagnosticsVerdict({ url, diagnostics });
  expect(v([])).toBeNull();
  expect(v([{ kind: 'pageerror', message: 'Error: NotImplemented: page\n    at x' }])).toBeNull();
  expect(v([{ kind: 'pageerror', message: 'ReferenceError: x is not defined' }])).toMatch(
    /the page threw: ReferenceError/,
  );
  // NotImplemented further down a stack does not excuse another error.
  expect(
    v([{ kind: 'pageerror', message: 'TypeError: boom\n    at NotImplemented (x.js:1:1)' }]),
  ).toMatch(/the page threw: TypeError: boom/);
  // Another host's failure is not the entry's; the entry's own is, unless the test blocked it.
  expect(v([{ kind: 'requestfailed', message: 'https://cdn.invalid/a.js: net::ERR_FAILED' }])).toBe(
    null,
  );
  expect(
    v([{ kind: 'requestfailed', message: 'http://127.0.0.1:40123/assets/a.js: net::ERR_FAILED' }]),
  ).toMatch(/a request of the entry failed/);
  expect(
    v([
      { kind: 'blocked-request', message: 'http://127.0.0.1:40123/v1/config' },
      {
        kind: 'requestfailed',
        message: 'http://127.0.0.1:40123/v1/config: net::ERR_BLOCKED_BY_CLIENT',
      },
    ]),
  ).toBeNull();
  // A URL that cannot be read counts as the entry's own (fail closed).
  expect(v([{ kind: 'requestfailed', message: 'not a url' }])).toMatch(/request of the entry/);
  expect(
    smokeDiagnosticsVerdict({
      url: '',
      diagnostics: [
        { kind: 'requestfailed', message: 'https://cdn.invalid/a.js: net::ERR_FAILED' },
      ],
    }),
  ).toMatch(/request of the entry/);
  expect(
    v([
      {
        kind: 'console.error',
        message:
          'TypeError: Failed to fetch dynamically imported module: http://127.0.0.1:40123/assets/p.js',
      },
    ]),
  ).toMatch(/a module of the page did not load/);
  // Only a first line that starts with NotImplemented (or Error: NotImplemented) is the
  // skeleton's; other kinds mentioning it are checked first and refused (Claude review r2, S2).
  expect(v([{ kind: 'pageerror', message: 'NotImplemented: AdminShell\n    at x' }])).toBeNull();
  for (const message of [
    'TypeError: NotImplemented is not a constructor',
    'ReferenceError: NotImplemented is not defined',
    'Error: x failed (NotImplemented)',
    'Uncaught NotImplemented',
    'Error: NotImplementedYet TypeError: y',
  ]) {
    expect(v([{ kind: 'pageerror', message }]), message).toMatch(/the page threw/);
  }
  // Other console errors stay attachments.
  expect(v([{ kind: 'console.error', message: 'Warning: something' }])).toBeNull();
  expect(
    v([{ kind: 'console.error', message: 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT' }]),
  ).toBeNull();
  expect(v([{ kind: 'blocked-websocket', message: 'ws://127.0.0.1:40123/' }])).toBeNull();
});

it('[F1-01k] a script error the page only logged refuses a red; the skeleton NotImplemented does not (Codex r3, S1 ②)', () => {
  const url = 'http://127.0.0.1:40123/';
  const v = (message: string): string | null =>
    smokeDiagnosticsVerdict({ url, diagnostics: [{ kind: 'console.error', message }] });
  const stack = '\n    at Xe (http://127.0.0.1:40123/assets/index-E7f8.js:9:1234)';
  const RR = 'React Router caught the following error during render ';
  // React Router's errorElement: whatever it caught, unless it is the skeleton's NotImplemented.
  for (const error of [
    "TypeError: Cannot read properties of undefined (reading 'map')",
    'ReferenceError: t is not defined',
    'RangeError: Invalid time value',
    'Error: boom',
    'Invariant failed',
  ]) {
    expect(v(`${RR}${error}${stack}`), error).toBe(
      `red for the wrong reason (the page logged a script error: ${RR}${error})`,
    );
  }
  // <Await>'s boundary logs the same way.
  expect(v(`<Await> caught the following error during render TypeError: x${stack}`)).toMatch(
    /logged a script error: <Await> caught/,
  );
  // Error kinds of a script fault, also without React Router (React's own caught-error log).
  for (const message of [
    `TypeError: Cannot read properties of null (reading 'x')${stack}`,
    'Uncaught SyntaxError: Unexpected identifier',
    'RangeError: Maximum call stack size exceeded',
    'URIError: URI malformed',
    'EvalError: x',
    `Error: wrapped${stack}\nCaused by: ReferenceError: y is not defined`,
  ]) {
    expect(v(message), message).toMatch(/the page logged a script error/);
  }
  // The skeleton's NotImplemented (first line of the error) stays a valid red, caught or not.
  for (const message of [
    `${RR}Error: NotImplemented: AppShell${stack}`,
    `${RR}NotImplemented: AppShell${stack}`,
    `Error: NotImplemented: AppShell${stack}`,
  ]) {
    expect(v(message), message).toBeNull();
  }
  // … but not another kind that mentions it.
  for (const message of [
    `${RR}TypeError: NotImplemented is not a constructor${stack}`,
    `${RR}ReferenceError: NotImplemented is not defined`,
    `${RR}Error: failed (NotImplemented)`,
  ]) {
    expect(v(message), message).toMatch(/the page logged a script error/);
  }
  expect(scriptFaultConsoleError(`${RR}Error: NotImplemented: x`, true)).toBe(false);
  expect(scriptFaultConsoleError(`${RR}Error: NotImplemented: x`, false)).toBe(true);
  expect(scriptFaultConsoleError('Warning: something', false)).toBe(false);
});

it('[F1-01k] a locator.waitFor timeout without browser diagnostics is not a valid red', () => {
  type Entry = { assertionResults: { fullName: string; annotations?: unknown[] }[] };
  const report = fixture('smoke-report.json') as { testResults: Entry[] };
  const waited = report.testResults[0]!.assertionResults.find(
    (t) => t.fullName === '[demo] element never came',
  )!;
  // Only the screenshot is left: the page events are unknown, the page may have thrown.
  waited.annotations = waited.annotations!.slice(0, 1);
  const result = checkRedReports([report], [SMOKE], ROOT);
  expect(result.red).toEqual([
    `${SMOKE} > [demo] assertion`,
    `${SMOKE} > [demo] skeleton caught by errorElement`,
  ]);
  expect(result.problems[0]).toEqual({
    file: SMOKE,
    test: '[demo] element never came',
    reason:
      'red for an unproven reason (locator.waitFor ran out but the test wrote no browser diagnostics annotation)',
  });
  expect(result.notes).toEqual([
    `${SMOKE} > [demo] element never came: locator.waitFor timeout without browser diagnostics, judged invalid`,
    `${SMOKE} > [demo] assertion: no browser diagnostics in the report, judged by the failure alone`,
  ]);
});

it('[F1-01k] smokeDiagnosticsOf reads only diagnostics attachments of the red reporter', () => {
  expect(smokeDiagnosticsOf(undefined)).toEqual([]);
  expect(
    smokeDiagnosticsOf([
      { message: 'x 首屏截图', type: 'notice', path: '/a.png' },
      { message: 'other', type: 'notice', json: { hello: 1 } },
      null,
      {
        message: 'x 浏览器诊断（不作为断言）',
        type: 'notice',
        json: { entry: 'x', url: 'http://127.0.0.1:1/', diagnostics: [{ kind: 'pageerror' }, 3] },
      },
    ]),
  ).toEqual([
    {
      url: 'http://127.0.0.1:1/',
      diagnostics: [
        { kind: 'pageerror', message: '' },
        { kind: '', message: '' },
      ],
    },
  ]);
});

it('[F1-01k] the locator.waitFor reading applies only to smoke files run in Node, from the red reporter', () => {
  type Entry = { name: string; browser: boolean; assertionResults: { failures?: unknown }[] };
  const load = (): { testResults: Entry[] } =>
    fixture('smoke-report.json') as { testResults: Entry[] };
  const waited = (r: ReturnType<typeof checkRedReports>): boolean =>
    r.red.some((x) => x.endsWith('[demo] element never came'));
  // The same file name outside the smoke pattern: an ordinary unit test, the timeout is refused.
  const renamed = load();
  const other = 'test/spec/frontend/build-smoke/entries.test.ts';
  renamed.testResults[0]!.name = `${ROOT}/${other}`;
  expect(waited(checkRedReports([renamed], [other], ROOT))).toBe(false);
  // A smoke-named file outside test/spec/ is not a rule test of the build-smoke project.
  for (const elsewhere of [
    'packages/testing/src/entries.smoke.test.ts',
    'test/acceptance/entries.smoke.test.ts',
  ]) {
    const moved = load();
    moved.testResults[0]!.name = `${ROOT}/${elsewhere}`;
    expect(waited(checkRedReports([moved], [elsewhere], ROOT))).toBe(false);
  }
  // A smoke-named file that ran in a browser is not a build smoke test.
  const inBrowser = load();
  inBrowser.testResults[0]!.browser = true;
  expect(waited(checkRedReports([inBrowser], [SMOKE], ROOT))).toBe(false);
  // Vitest's own JSON report (messages only, no causes): refused.
  const plain = load();
  for (const t of plain.testResults[0]!.assertionResults) delete t.failures;
  expect(waited(checkRedReports([plain], [SMOKE], ROOT))).toBe(false);
  // A globalSetup that failed runs no test: the file is not in the report.
  expect(checkRedReports([{ testResults: [] }], [SMOKE], ROOT).problems).toEqual([
    { file: SMOKE, test: null, reason: 'not in the report: this rule-test file did not run' },
  ]);
});

it('[F1-01k] smokeCauseVerdict: only the bare locator.waitFor TimeoutError and assertions count', () => {
  const wait = 'locator.waitFor: Timeout 10000ms exceeded.\nCall log:\n  - waiting for x';
  expect(smokeCauseVerdict([{ name: 'TimeoutError', message: wait }])).toBeNull();
  expect(smokeCauseVerdict([{ name: 'AssertionError', message: 'expected 1 to be 2' }])).toBeNull();
  // Wrapped, or named otherwise, it is not the wait of the test.
  expect(
    smokeCauseVerdict([
      { name: 'Error', message: 'wrapper' },
      { name: 'TimeoutError', message: wait },
    ]),
  ).not.toBeNull();
  expect(smokeCauseVerdict([{ name: 'Error', message: wait }])).not.toBeNull();
  expect(
    smokeCauseVerdict([
      { name: 'TimeoutError', message: 'locator.click: Timeout 5000ms exceeded.' },
    ]),
  ).toMatch(/outside locator\.waitFor/);
  // A failed globalSetup reported as an error outside the tests.
  expect(
    smokeCauseVerdict([
      { name: 'Error', message: 'build smoke: the admin build (vite build) exited 1' },
    ]),
  ).toMatch(/unrecognised/);
  expect(smokeCauseVerdict([])).toMatch(/unknown reason/);
});

const ROUTE_ERROR = 'the route error page (RetryPage "页面加载失败，请重试") is showing at /rules';

it('[F1-01m] what the page swallowed refuses a wait that ran out; the skeleton NotImplemented does not', () => {
  const result = checkRedReports([fixture('smoke-swallowed-report.json')], [SMOKE], ROOT);
  expect(result.ok).toBe(false);
  // The skeleton's NotImplemented explains the route error page: the wait still counts.
  expect(result.red).toEqual([
    `${SMOKE} > [demo] skeleton lazy module`,
    `${SMOKE} > [demo] skeleton render caught by errorElement`,
  ]);
  expect(result.problems.map((p) => [p.test, p.reason])).toEqual([
    // A lazy chunk served 200 whose module throws while initialising (Codex money r4 S1 on
    // F1-01k): no console.error, no pageerror, only vite:preloadError and the retry page.
    [
      '[demo] lazy module threw while initialising',
      "red for the wrong reason (a lazy module of the page failed: TypeError: Cannot read properties of undefined (reading 'x'))",
    ],
    [
      '[demo] route error page only',
      `red for the wrong reason (the page showed its route error page: ${ROUTE_ERROR})`,
    ],
    [
      '[demo] unhandled rejection',
      'red for the wrong reason (the page left a rejection unhandled: Error: boom)',
    ],
    [
      '[demo] page could not be read',
      'red for an unproven reason (the page events are not fully known: the page could not be read: reading the page timed out (5000ms))',
    ],
  ]);
  expect(result.notes).toEqual([]);
});

it('[F1-01m] smokeDiagnosticsVerdict: preload errors, unhandled rejections, the route error page, unreadable pages', () => {
  const url = 'http://127.0.0.1:40123/';
  const v = (diagnostics: { kind: string; message: string }[]): string | null =>
    smokeDiagnosticsVerdict({ url, diagnostics });
  const stack = `\n    at ${url}assets/page-D5e6.js:1:88`;
  for (const kind of ['preload-error', 'unhandled-rejection']) {
    // Only a first line that starts with NotImplemented (or Error: NotImplemented) is excused.
    expect(v([{ kind, message: `Error: NotImplemented: RulesPage${stack}` }]), kind).toBeNull();
    expect(v([{ kind, message: `NotImplemented: RulesPage${stack}` }]), kind).toBeNull();
    for (const message of [
      `TypeError: Failed to fetch dynamically imported module: ${url}assets/page-D5e6.js`,
      `TypeError: NotImplemented is not a constructor${stack}`,
      'Error: Unable to preload CSS for /assets/page-D5e6.css',
      'undefined',
    ]) {
      expect(v([{ kind, message }]), `${kind}: ${message}`).toMatch(/^red for the wrong reason/);
    }
  }
  // The route error page alone, or beside a NotImplemented that is not the skeleton's.
  expect(v([{ kind: 'route-error', message: ROUTE_ERROR }])).toBe(
    `red for the wrong reason (the page showed its route error page: ${ROUTE_ERROR})`,
  );
  expect(
    v([
      { kind: 'pageerror', message: 'Error: x failed (NotImplemented)' },
      { kind: 'route-error', message: ROUTE_ERROR },
    ]),
  ).toMatch(/the page threw/);
  expect(
    v([
      { kind: 'console.error', message: 'Warning: NotImplemented: x' },
      { kind: 'route-error', message: ROUTE_ERROR },
    ]),
  ).toMatch(/route error page/);
  // … excused by the skeleton's NotImplemented in any of the kinds that carry an error.
  for (const skeleton of [
    { kind: 'pageerror', message: 'Error: NotImplemented: AppShell' },
    { kind: 'preload-error', message: 'NotImplemented: RulesPage' },
    { kind: 'unhandled-rejection', message: 'Error: NotImplemented: load' },
    {
      kind: 'console.error',
      message: `React Router caught the following error during render Error: NotImplemented: AppShell${stack}`,
    },
  ]) {
    expect(v([skeleton, { kind: 'route-error', message: ROUTE_ERROR }]), skeleton.kind).toBeNull();
  }
  // Unreadable page events: never a proven red.
  expect(v([{ kind: 'diagnostics-incomplete', message: 'the page could not be read: x' }])).toBe(
    'red for an unproven reason (the page events are not fully known: the page could not be read: x)',
  );
});

// CT-06p: files that existed at the base need only their new and changed tests red.
const BASE_FILE = 'test/spec/notify/send-log.int.test.ts';
const VITEST = "import { expect, it } from 'vitest';";
const spec = (title: string, body = 'expect(1).toBe(1);'): string =>
  `it('${title}', async () => {\n  ${body}\n});`;
const file = (...tests: string[]): string => `${[VITEST, ...tests].join('\n\n')}\n`;
const BASE_SOURCE = file(spec('[AC-1] a'), spec('[AC-2] b'), spec('[AC-3] c'), spec('[AC-4] d'));
/** Tests 1 and 4 changed, test 5 is new (the B1-12f shape plus a new test). */
const HEAD_SOURCE = file(
  spec('[AC-1] a', "expect(await columns()).toEqual(['app_id', 'variant']);"),
  spec('[AC-2] b'),
  spec('[AC-3] c'),
  spec('[AC-4] d', "expect(await primaryKey()).toEqual(['app_id', 'code', 'variant']);"),
  spec('[AC-5] e'),
);

type RedTest = [name: string, status: string, cause?: string];
/** A report as the red reporter writes it (reporter name, failure causes). */
function redReport(name: string, tests: RedTest[], reporter = 'couli-red-reporter') {
  const causesOf = (cause: string) => {
    const at = cause.indexOf(': ');
    return [{ name: cause.slice(0, at), message: cause.slice(at + 2) }];
  };
  return {
    reporter,
    testResults: [
      {
        name: `${ROOT}/${name}`,
        status: 'failed',
        message: '',
        failures: [],
        assertionResults: tests.map(([fullName, status, cause]) => ({
          fullName,
          title: fullName,
          status,
          failureMessages: cause === undefined ? [] : [cause],
          failures: cause === undefined ? [] : [{ causes: causesOf(cause) }],
        })),
      },
    ],
  };
}

function reader(base: Record<string, string>, head: Record<string, string>): BaselineReader {
  return { base: (p) => base[p] ?? null, head: (p) => head[p] ?? null };
}

const baselinesOf = (
  head: string,
  changes: Change[] = [{ path: BASE_FILE, status: 'M' }],
  extra: Record<string, string> = {},
) =>
  ruleTestBaselines(
    [BASE_FILE],
    changes,
    ['test/spec/notify/**'],
    reader({ [BASE_FILE]: BASE_SOURCE }, { [BASE_FILE]: head, ...extra }),
  );

it('[CT-06p] a file that existed at the base: only new and changed tests must be red, unchanged ones are listed', () => {
  const result = checkRedReports(
    [
      redReport(BASE_FILE, [
        ['[AC-1] a', 'failed', 'AssertionError: expected [ …(2) ] to deeply equal [ …(3) ]'],
        ['[AC-2] b', 'passed'],
        ['[AC-3] c', 'failed', 'Error: NotImplemented: columns'],
        ['[AC-4] d', 'failed', 'AssertionError: expected [ …(2) ] to deeply equal [ …(3) ]'],
        ['[AC-5] e', 'failed', 'Error: NotImplemented: insert'],
      ]),
    ],
    [BASE_FILE],
    ROOT,
    baselinesOf(HEAD_SOURCE),
  );
  expect(result).toEqual({
    ok: true,
    red: [
      `${BASE_FILE} > [AC-1] a`,
      `${BASE_FILE} > [AC-3] c`,
      `${BASE_FILE} > [AC-4] d`,
      `${BASE_FILE} > [AC-5] e`,
    ],
    problems: [],
    exempt: [
      { file: BASE_FILE, test: '[AC-2] b', status: 'passed' },
      { file: BASE_FILE, test: '[AC-3] c', status: 'failed' },
    ],
    notes: [
      `${BASE_FILE} > [AC-2] b: unchanged since the base, exempt from the red rule (green)`,
      `${BASE_FILE} > [AC-3] c: unchanged since the base, exempt from the red rule (red for a valid reason)`,
    ],
  });
});

it('[CT-06p] an unchanged test that is red still needs a valid reason; skipped stays refused; a changed green test has no teeth', () => {
  const result = checkRedReports(
    [
      redReport(BASE_FILE, [
        ['[AC-1] a', 'passed'],
        ['[AC-2] b', 'failed', 'TypeError: columns is not a function'],
        ['[AC-3] c', 'skipped'],
        ['[AC-4] d', 'failed', 'AssertionError: x'],
        ['[AC-5] e', 'passed'],
      ]),
    ],
    [BASE_FILE],
    ROOT,
    baselinesOf(HEAD_SOURCE),
  );
  expect(result.ok).toBe(false);
  expect(result.problems.map((p) => `${p.test}: ${p.reason}`)).toEqual([
    '[AC-1] a: green on the skeleton: the test has no teeth (new or changed since the base)',
    '[AC-2] b: red for the wrong reason (TypeError)',
    '[AC-3] c: status "skipped" (skipped, todo or pending is not red)',
    '[AC-5] e: green on the skeleton: the test has no teeth (new or changed since the base)',
  ]);
  expect(result.exempt).toEqual([]);
});

it('[CT-06p] a file that existed at the base and has no new or changed test fails: nothing is shown red', () => {
  const comments = BASE_SOURCE.replace('expect(1)', '// only a comment\n  expect(1)');
  const result = checkRedReports(
    [
      redReport(BASE_FILE, [
        ['[AC-1] a', 'passed'],
        ['[AC-2] b', 'passed'],
        ['[AC-3] c', 'passed'],
        ['[AC-4] d', 'passed'],
      ]),
    ],
    [BASE_FILE],
    ROOT,
    baselinesOf(comments),
  );
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual([
    {
      file: BASE_FILE,
      test: null,
      reason:
        'existed at the base and has no new or changed test: nothing is shown red (4 unchanged test(s))',
    },
  ]);
  expect(result.exempt).toHaveLength(4);
});

it('[CT-06p] judged as a whole, as before: shared code changed, a support file it may read, not the red reporter', () => {
  const tests: RedTest[] = [
    ['[AC-1] a', 'failed', 'AssertionError: x'],
    ['[AC-2] b', 'passed'],
    ['[AC-3] c', 'passed'],
    ['[AC-4] d', 'failed', 'AssertionError: x'],
    ['[AC-5] e', 'failed', 'Error: NotImplemented: x'],
  ];
  const greenOnes = (r: ReturnType<typeof checkRedReports>) =>
    r.problems.map((p) => `${p.test}: ${p.reason}`);
  const teeth = 'green on the skeleton: the test has no teeth';

  // A helper outside the tests changed.
  const helper = HEAD_SOURCE.replace(VITEST, `${VITEST}\nconst helper = () => 2;`);
  const shared = checkRedReports(
    [redReport(BASE_FILE, tests)],
    [BASE_FILE],
    ROOT,
    baselinesOf(helper),
  );
  expect(greenOnes(shared)).toEqual([`[AC-2] b: ${teeth}`, `[AC-3] c: ${teeth}`]);
  expect(shared.notes).toEqual([
    `${BASE_FILE}: existed at the base, judged as a whole (every test must be red): code outside the tests changed (imports, helpers, hooks, top-level tables or describe titles)`,
  ]);
  expect(shared.exempt).toEqual([]);

  // A data file the task changed, which the test file names.
  const reads = HEAD_SOURCE.replace('[AC-5] e', '[AC-5] e reads ./expected.csv');
  const support = checkRedReports(
    [
      redReport(
        BASE_FILE,
        tests.map(([n, s, c]) =>
          n === '[AC-5] e' ? ['[AC-5] e reads ./expected.csv', s, c] : [n, s, c],
        ) as RedTest[],
      ),
    ],
    [BASE_FILE],
    ROOT,
    baselinesOf(reads, [
      { path: BASE_FILE, status: 'M' },
      { path: 'test/spec/notify/expected.csv', status: 'M' },
    ]),
  );
  // CT-06r: without a declaration in the ledger the file is whole, as before.
  expect(greenOnes(support)).toEqual([
    `[AC-2] b: ${teeth} (the file may read a test-support file the task changed and the ledger does not declare this test exempt)`,
    `[AC-3] c: ${teeth} (the file may read a test-support file the task changed and the ledger does not declare this test exempt)`,
  ]);
  expect(support.notes[0]).toBe(
    `${BASE_FILE}: existed at the base, judged as a whole except the tests the ledger declares exempt (every other test must be red): it may read a test-support file the task changed: ${BASE_FILE} names expected.csv`,
  );
  expect(support.exempt).toEqual([]);

  // Vitest's own JSON report (no reporter name): its full names are not `suite > test`.
  const plain = checkRedReports(
    [redReport(BASE_FILE, tests, 'vitest-json')],
    [BASE_FILE],
    ROOT,
    baselinesOf(HEAD_SOURCE),
  );
  expect(greenOnes(plain)).toEqual([`[AC-2] b: ${teeth}`, `[AC-3] c: ${teeth}`]);
  expect(plain.notes).toEqual([
    `${BASE_FILE}: existed at the base, judged as a whole (every test must be red): the report is not from the red reporter`,
  ]);
});

it('[CT-06p] ruleTestBaselines: new and renamed files keep the old rule; JSX, unreadable heads and support files are whole', () => {
  const NEW = 'test/spec/notify/override.int.test.ts';
  const RENAMED = 'test/spec/notify/renamed.test.ts';
  const JSX = 'test/spec/notify/page.browser.test.tsx';
  const GONE = 'test/spec/notify/gone.test.ts';
  const read = reader(
    {
      [BASE_FILE]: BASE_SOURCE,
      'test/spec/notify/old.test.ts': BASE_SOURCE,
      [JSX]: BASE_SOURCE,
      [GONE]: BASE_SOURCE,
    },
    { [BASE_FILE]: HEAD_SOURCE, [NEW]: HEAD_SOURCE, [RENAMED]: BASE_SOURCE, [JSX]: HEAD_SOURCE },
  );
  const changes: Change[] = [
    { path: BASE_FILE, status: 'M' },
    { path: NEW, status: 'A' },
    { path: RENAMED, status: 'R', oldPath: 'test/spec/notify/old.test.ts' },
    { path: JSX, status: 'M' },
    { path: GONE, status: 'M' },
    // Outside the test_paths: never a test-support file.
    { path: 'apps/api/src/modules/notification/expected.csv', status: 'M' },
  ];
  const b = ruleTestBaselines(
    [BASE_FILE, NEW, RENAMED, JSX, GONE],
    changes,
    ['test/spec/notify/**'],
    read,
  );
  expect([...b.keys()].sort()).toEqual([BASE_FILE, GONE, JSX].sort());
  expect(b.get(BASE_FILE)?.kind).toBe('tests');
  expect(b.get(JSX)).toEqual({
    kind: 'whole',
    reason: 'only .ts / .js rule-test files are compared test by test (JSX is not read)',
  });
  expect(b.get(GONE)).toEqual({
    kind: 'whole',
    reason: 'its content in the red run cannot be read',
  });
  // The renamed file's old path is a changed file in scope: a file that names it is whole.
  const naming = HEAD_SOURCE.replace('[AC-5] e', '[AC-5] e after old.test.ts');
  const n = ruleTestBaselines(
    [BASE_FILE],
    changes,
    ['test/spec/notify/**'],
    reader({ [BASE_FILE]: BASE_SOURCE }, { [BASE_FILE]: naming }),
  );
  // CT-06r: such a file keeps its compared blocks, so a declared exemption can be judged.
  expect(n.get(BASE_FILE)).toMatchObject({
    kind: 'support',
    reason: `it may read a test-support file the task changed: ${BASE_FILE} names old.test.ts`,
  });
  expect((n.get(BASE_FILE) as { blocks: unknown[] }).blocks).toHaveLength(5);
});

// CT-06r: declared exemptions for the unchanged tests of a file that may read a changed
// test-support file (the B2-01l shape: a data-driven test file whose structural tests hold for the
// old data too).
const SUPPORT_SOURCE = HEAD_SOURCE.replace('[AC-5] e', '[AC-5] e reads ./expected.csv');
const SUPPORT_CHANGES: Change[] = [
  { path: BASE_FILE, status: 'M' },
  { path: 'test/spec/notify/expected.csv', status: 'M' },
];
const supportBaselines = () => baselinesOf(SUPPORT_SOURCE, SUPPORT_CHANGES);
const SUPPORT_TESTS: RedTest[] = [
  ['[AC-1] a', 'failed', 'AssertionError: x'],
  ['[AC-2] b', 'passed'],
  ['[AC-3] c', 'passed'],
  ['[AC-4] d', 'failed', 'AssertionError: x'],
  ['[AC-5] e reads ./expected.csv', 'failed', 'Error: NotImplemented: x'],
];
const REASON = 'structural: holds for the old csv too, cannot be red';
const declare = (test: string, reason = REASON, file = BASE_FILE) => ({ file, test, reason });
const CONFIRM =
  "needs the rule-test reviewer's confirmation (evidence spec_test_review.red_exempt_confirmed)";

it('[CT-06r] a declared, unchanged test of a file that may read a changed data file may be green; the undeclared ones stay red', () => {
  const result = checkRedReports(
    [redReport(BASE_FILE, SUPPORT_TESTS)],
    [BASE_FILE],
    ROOT,
    supportBaselines(),
    [declare('[AC-2] b')],
  );
  // [AC-3] c is unchanged too but not declared: it must be red, as under CT-06p.
  expect(result.problems).toEqual([
    {
      file: BASE_FILE,
      test: '[AC-3] c',
      reason:
        'green on the skeleton: the test has no teeth (the file may read a test-support file the task changed and the ledger does not declare this test exempt)',
    },
  ]);
  expect(result.exempt).toEqual([
    { file: BASE_FILE, test: '[AC-2] b', status: 'passed', declared: true, reason: REASON },
  ]);
  expect(result.red).toEqual([
    `${BASE_FILE} > [AC-1] a`,
    `${BASE_FILE} > [AC-4] d`,
    `${BASE_FILE} > [AC-5] e reads ./expected.csv`,
  ]);
  expect(result.notes).toEqual([
    `${BASE_FILE}: existed at the base, judged as a whole except the tests the ledger declares exempt (every other test must be red): it may read a test-support file the task changed: ${BASE_FILE} names expected.csv`,
    `${BASE_FILE} > [AC-2] b: unchanged since the base, exempt by the task's declaration (green; reason: ${REASON}); ${CONFIRM}`,
  ]);
  // Both unchanged tests declared: the file passes with its three changed tests red.
  const both = checkRedReports(
    [redReport(BASE_FILE, SUPPORT_TESTS)],
    [BASE_FILE],
    ROOT,
    supportBaselines(),
    [declare('[AC-2] b'), declare('[AC-3] c', '[AC-3] 只核对 csv 列数，对旧 csv 同样成立')],
  );
  expect(both.ok).toBe(true);
  expect(both.exempt?.map((e) => e.test)).toEqual(['[AC-2] b', '[AC-3] c']);
  // A declared test that is red still needs a valid reason; it is listed as exempt (red).
  const redDeclared = checkRedReports(
    [
      redReport(
        BASE_FILE,
        SUPPORT_TESTS.map(([n, s, c]) =>
          n === '[AC-2] b' ? ['[AC-2] b', 'failed', 'Error: NotImplemented: x'] : [n, s, c],
        ) as RedTest[],
      ),
    ],
    [BASE_FILE],
    ROOT,
    supportBaselines(),
    [declare('[AC-2] b'), declare('[AC-3] c')],
  );
  expect(redDeclared.ok).toBe(true);
  expect(redDeclared.exempt).toEqual([
    { file: BASE_FILE, test: '[AC-2] b', status: 'failed', declared: true, reason: REASON },
    { file: BASE_FILE, test: '[AC-3] c', status: 'passed', declared: true, reason: REASON },
  ]);
  const wrong = checkRedReports(
    [
      redReport(
        BASE_FILE,
        SUPPORT_TESTS.map(([n, s, c]) =>
          n === '[AC-2] b'
            ? ['[AC-2] b', 'failed', 'TypeError: rows is not a function']
            : [n, s, c],
        ) as RedTest[],
      ),
    ],
    [BASE_FILE],
    ROOT,
    supportBaselines(),
    [declare('[AC-2] b'), declare('[AC-3] c')],
  );
  expect(wrong.problems.map((p) => `${p.test}: ${p.reason}`)).toEqual([
    '[AC-2] b: red for the wrong reason (TypeError)',
  ]);
});

it('[CT-06r] a declaration does not apply to a new or changed test, nor without a reason of 10 characters', () => {
  // [AC-1] a changed and [AC-5] e is new: declared or not, they must be red.
  const changed = checkRedReports(
    [
      redReport(BASE_FILE, [
        ['[AC-1] a', 'passed'],
        ['[AC-2] b', 'passed'],
        ['[AC-3] c', 'passed'],
        ['[AC-4] d', 'failed', 'AssertionError: x'],
        ['[AC-5] e reads ./expected.csv', 'passed'],
      ]),
    ],
    [BASE_FILE],
    ROOT,
    supportBaselines(),
    [
      declare('[AC-1] a'),
      declare('[AC-2] b'),
      declare('[AC-3] c'),
      declare('[AC-5] e reads ./expected.csv'),
    ],
  );
  expect(changed.ok).toBe(false);
  expect(changed.problems.map((p) => p.test)).toEqual([
    '[AC-1] a',
    '[AC-5] e reads ./expected.csv',
  ]);
  expect(changed.exempt?.map((e) => e.test)).toEqual(['[AC-2] b', '[AC-3] c']);
  expect(changed.notes).toContain(
    `${BASE_FILE} > [AC-1] a: declared exempt, but the declaration does not apply: the test is new or changed since the base (only an unchanged test may be declared exempt); the test must be red`,
  );
  expect(changed.notes).toContain(
    `${BASE_FILE} > [AC-5] e reads ./expected.csv: declared exempt, but the declaration does not apply: the test is new or changed since the base (only an unchanged test may be declared exempt); the test must be red`,
  );
  // A reason that is missing, blank or too short: the declaration does not apply.
  for (const reason of ['', '         ', 'too short']) {
    const short = checkRedReports(
      [redReport(BASE_FILE, SUPPORT_TESTS)],
      [BASE_FILE],
      ROOT,
      supportBaselines(),
      [declare('[AC-2] b', reason), declare('[AC-3] c')],
    );
    expect(short.ok, JSON.stringify(reason)).toBe(false);
    expect(short.problems.map((p) => p.test)).toEqual(['[AC-2] b']);
    expect(short.notes).toContain(
      `${BASE_FILE} > [AC-2] b: declared exempt, but the declaration does not apply: the reason is shorter than 10 characters; the test must be red`,
    );
  }
  // A declaration must name the test's full name exactly: a title, a prefix, another file do not.
  const miss = checkRedReports(
    [redReport(BASE_FILE, SUPPORT_TESTS)],
    [BASE_FILE],
    ROOT,
    supportBaselines(),
    [
      declare('[AC-2]'),
      declare('b'),
      declare('[AC-2] b', REASON, 'test/spec/notify/other.test.ts'),
    ],
  );
  expect(miss.problems.map((p) => p.test)).toEqual(['[AC-2] b', '[AC-3] c']);
  expect(miss.exempt).toEqual([]);
  expect(miss.notes).toContain(
    `${BASE_FILE}: the declared exemption of "[AC-2]" matches no test of the report (the full name must be exactly the red reporter's)`,
  );
  expect(miss.notes).toContain(
    'declared exemption of test/spec/notify/other.test.ts > [AC-2] b: test/spec/notify/other.test.ts is not an expected rule-test file (ignored)',
  );
});

it('[CT-06r] a declaration applies only to a file judged whole because of a changed test-support file; every test declared fails', () => {
  const declared = [declare('[AC-2] b'), declare('[AC-3] c')];
  const teeth = 'green on the skeleton: the test has no teeth';
  // Code outside the tests changed: whole, the declarations do not apply.
  const helper = HEAD_SOURCE.replace(VITEST, `${VITEST}\nconst helper = () => 2;`);
  const shared = checkRedReports(
    [redReport(BASE_FILE, SUPPORT_TESTS.slice(0, 4))],
    [BASE_FILE],
    ROOT,
    baselinesOf(helper, SUPPORT_CHANGES),
    declared,
  );
  expect(shared.problems.map((p) => `${p.test}: ${p.reason}`)).toEqual([
    `[AC-2] b: ${teeth}`,
    `[AC-3] c: ${teeth}`,
  ]);
  expect(shared.exempt).toEqual([]);
  expect(shared.notes[1]).toBe(
    `${BASE_FILE}: 2 declared exemption(s) do not apply: code outside the tests changed (imports, helpers, hooks, top-level tables or describe titles) (a declaration applies only to a file judged as a whole because it may read a changed test-support file)`,
  );
  // Not the red reporter: whole, the declarations do not apply.
  const plain = checkRedReports(
    [redReport(BASE_FILE, SUPPORT_TESTS, 'vitest-json')],
    [BASE_FILE],
    ROOT,
    supportBaselines(),
    declared,
  );
  expect(plain.problems.map((p) => p.test)).toEqual(['[AC-2] b', '[AC-3] c']);
  expect(plain.notes[1]).toContain(
    '2 declared exemption(s) do not apply: the report is not from the red reporter',
  );
  // A file judged test by test (no support file changed): the declarations are not needed.
  const tests = checkRedReports(
    [redReport(BASE_FILE, SUPPORT_TESTS)],
    [BASE_FILE],
    ROOT,
    baselinesOf(SUPPORT_SOURCE),
    declared,
  );
  expect(tests.ok).toBe(true);
  expect(tests.exempt).toEqual([
    { file: BASE_FILE, test: '[AC-2] b', status: 'passed' },
    { file: BASE_FILE, test: '[AC-3] c', status: 'passed' },
  ]);
  expect(tests.notes[0]).toBe(
    `${BASE_FILE}: 2 declared exemption(s) are not needed: the file is judged test by test (its unchanged tests are exempt by themselves)`,
  );
  // A new file: no baseline, the declarations do not apply (every test red).
  const NEW = 'test/spec/notify/new.test.ts';
  const fresh = checkRedReports(
    [redReport(NEW, [['[AC-1] a', 'passed']])],
    [NEW],
    ROOT,
    new Map(),
    [declare('[AC-1] a', REASON, NEW)],
  );
  expect(fresh.problems.map((p) => p.reason)).toEqual([teeth]);
  expect(fresh.notes).toEqual([
    `${NEW}: 1 declared exemption(s) do not apply: the file is new, renamed or could not be compared with the base (a declaration applies only to a file judged as a whole because it may read a changed test-support file)`,
  ]);
  // Without baselines (no --base) declarations are ignored and the result keeps its old shape.
  const old = checkRedReports(
    [redReport(BASE_FILE, SUPPORT_TESTS)],
    [BASE_FILE],
    ROOT,
    undefined,
    declared,
  );
  expect(old.exempt).toBeUndefined();
  expect(old.problems.map((p) => p.test)).toEqual(['[AC-2] b', '[AC-3] c']);
  expect(old.notes).toEqual([]);
  // Every test of the file unchanged and declared: nothing would be shown red.
  const same = SUPPORT_SOURCE.replace(
    "expect(await columns()).toEqual(['app_id', 'variant']);",
    'expect(1).toBe(1);',
  )
    .replace(
      "expect(await primaryKey()).toEqual(['app_id', 'code', 'variant']);",
      'expect(1).toBe(1);',
    )
    .replace(spec('[AC-5] e reads ./expected.csv'), '')
    .replace(/\n+$/, '\n');
  const all = checkRedReports(
    [
      redReport(BASE_FILE, [
        ['[AC-1] a', 'passed'],
        ['[AC-2] b', 'passed'],
        ['[AC-3] c', 'passed'],
        ['[AC-4] d', 'passed'],
      ]),
    ],
    [BASE_FILE],
    ROOT,
    baselinesOf(`${same.trimEnd()} // reads ./expected.csv\n`, SUPPORT_CHANGES),
    ['[AC-1] a', '[AC-2] b', '[AC-3] c', '[AC-4] d'].map((t) => declare(t)),
  );
  expect(all.ok).toBe(false);
  expect(all.problems).toEqual([
    {
      file: BASE_FILE,
      test: null,
      reason:
        'existed at the base and every test is declared exempt: nothing is shown red (4 test(s); evidence-check wants a red test of every expected file)',
    },
  ]);
  expect(all.exempt).toHaveLength(4);
});

it('[CT-06p] without baselines the result keeps its old shape (no exempt list)', () => {
  const result = checkRedReports(
    [redReport(BASE_FILE, [['[AC-1] a', 'passed']])],
    [BASE_FILE],
    ROOT,
  );
  expect(result.exempt).toBeUndefined();
  expect(result.problems[0]?.reason).toBe('green on the skeleton: the test has no teeth');
});

// CT-06w (B1-12g red/4): the two platform contract tests, unchanged in their tests, were judged
// whole because `./kit.ts` of their own directory shares its basename with the identity kit the
// task changed (test/spec/identity/step-up-verify/kit.ts). Imports are resolved to paths now.
it('[CT-06w] ruleTestBaselines: an import of a same-named file in another directory is not a read of the changed support file', () => {
  const fixture = (p: string): string => readFileSync(join(FIXTURES, `b112g-${p}.txt`), 'utf8');
  const EVENTS = 'test/spec/platform/events/contract.test.ts';
  const QUEUE = 'test/spec/platform/queue/contract.test.ts';
  const IDENTITY_KIT = 'test/spec/identity/step-up-verify/kit.ts';
  const tree: Record<string, string> = {
    [EVENTS]: fixture('events-contract.test.ts'),
    [QUEUE]: fixture('queue-contract.test.ts'),
    'test/spec/platform/events/kit.ts': fixture('events-kit.ts'),
    'test/spec/platform/queue/kit.ts': fixture('queue-kit.ts'),
    'test/spec/platform/db/kit.ts': fixture('db-kit.ts'),
    [IDENTITY_KIT]: fixture('identity-step-up-verify-kit.ts'),
  };
  const scope = [
    'test/spec/notification/risk-state-message/**',
    EVENTS,
    QUEUE,
    'test/spec/platform/idempotency/abandon-route/http-kit.ts',
    'test/spec/identity/identity-level/http-kit.ts',
    'test/spec/identity/bind-phone/http-kit.ts',
    IDENTITY_KIT,
    'test/spec/identity/sms-codes/http-kit.ts',
  ];
  const changes: Change[] = [
    { path: EVENTS, status: 'M' },
    { path: QUEUE, status: 'M' },
    { path: 'test/spec/platform/idempotency/abandon-route/http-kit.ts', status: 'M' },
    { path: 'test/spec/identity/identity-level/http-kit.ts', status: 'M' },
    { path: 'test/spec/identity/sms-codes/http-kit.ts', status: 'M' },
    { path: IDENTITY_KIT, status: 'M' },
    { path: 'test/spec/notification/risk-state-message/render.test.ts', status: 'A' },
    { path: 'test/spec/notification/risk-state-message/db-kit.ts', status: 'A' },
  ];
  // The test bodies did not change (the same text at the base), only the kits elsewhere did.
  const unchanged = ruleTestBaselines([EVENTS, QUEUE], changes, scope, reader(tree, tree));
  expect(unchanged.get(EVENTS)?.kind).toBe('tests');
  expect(unchanged.get(QUEUE)?.kind).toBe('tests');
  // The kit of its own directory changed: whole, through the resolved import.
  const own = ruleTestBaselines(
    [EVENTS, QUEUE],
    [...changes, { path: 'test/spec/platform/events/kit.ts', status: 'M' }],
    [...scope, 'test/spec/platform/events/kit.ts'],
    reader(tree, tree),
  );
  expect(own.get(EVENTS)).toMatchObject({
    kind: 'support',
    reason:
      'it may read a test-support file the task changed: it loads test/spec/platform/events/kit.ts',
  });
  expect(own.get(QUEUE)?.kind).toBe('tests');
  // An import that cannot be resolved keeps the old judgement, and the notes say so.
  const bare = {
    ...tree,
    [QUEUE]: tree[QUEUE]?.replace("from './kit.ts'", "from 'queue-kit/kit.ts'") ?? '',
  };
  const kept = ruleTestBaselines([EVENTS, QUEUE], changes, scope, reader(bare, bare));
  expect(kept.get(QUEUE)).toMatchObject({
    kind: 'support',
    reason: `it may read a test-support file the task changed: ${QUEUE} names kit.ts in an unresolved import queue-kit/kit.ts (a package (no tsconfig paths map it))`,
  });
});
