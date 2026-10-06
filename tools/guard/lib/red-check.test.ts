// Unit tests of the red check (规划/11 §2.3 step 3; ops/approvals.yaml id 19; Codex review
// CR-10, CR-11 of 2026-10-05).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  browserCauseVerdict,
  causeVerdict,
  checkRedReports,
  expectedRuleTests,
  redCheckRequired,
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
  expect(result.red).toEqual([
    `${SMOKE} > [demo] element never came`,
    `${SMOKE} > [demo] assertion`,
  ]);
  expect(result.problems.map((p) => [p.test, p.reason])).toEqual([
    [
      '[demo] page threw',
      "red for the wrong reason (the page threw: TypeError: Cannot read properties of undefined (reading 'routes'))",
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
  expect(v([{ kind: 'blocked-websocket', message: 'ws://127.0.0.1:40123/' }])).toBeNull();
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
  expect(result.red).toEqual([`${SMOKE} > [demo] assertion`]);
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
