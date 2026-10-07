// Strict reporter of the build smoke (F1-01k, Codex review r2 S1): a green run fails when the
// browser diagnostics the rule tests attach show a page error, a failed request of the entry's
// own origin that the test did not block, or a module that did not load.
import { afterEach, expect, it, vi } from 'vitest';
import StrictSmokeReporter, {
  smokeDiagnosticsFindings,
  testCaseFindings,
} from './strict-reporter.mjs';

const URL_ = 'http://127.0.0.1:40123/';
type Diagnostic = { kind: string; message: string };

/** One annotation as Vitest 5.0.1 hands it to reporters (string body labelled base64). */
function diagnosticsAnnotation(entry: string, diagnostics: Diagnostic[], base64 = true): unknown {
  const body = JSON.stringify({ entry, url: URL_, diagnostics }, null, 2);
  return {
    message: `${entry} 浏览器诊断（不作为断言）`,
    type: 'notice',
    attachment: {
      contentType: 'application/json',
      body: base64 ? Buffer.from(body).toString('base64') : body,
      bodyEncoding: 'base64',
    },
  };
}

const SCREENSHOT = {
  message: 'admin 首屏截图',
  type: 'notice',
  attachment: { contentType: 'image/png', path: '/work/repo/test/.vitest/attachments/a.png' },
};

// The admin first screen as it really runs: the permission endpoint and another host are blocked
// by the test itself, and Chromium logs the blocked load as a console error.
const BLOCKED_ONLY: Diagnostic[] = [
  { kind: 'blocked-request', message: `${URL_}admin/v1/me/permissions` },
  { kind: 'requestfailed', message: `${URL_}admin/v1/me/permissions: net::ERR_BLOCKED_BY_CLIENT` },
  { kind: 'console.error', message: 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT' },
  { kind: 'blocked-request', message: 'https://fonts.example.invalid/a.woff2' },
  {
    kind: 'requestfailed',
    message: 'https://fonts.example.invalid/a.woff2: net::ERR_BLOCKED_BY_CLIENT',
  },
  { kind: 'blocked-websocket', message: 'ws://127.0.0.1:40123/' },
];

function moduleOf(tests: { fullName: string; annotations: unknown[] }[]): unknown {
  return {
    children: {
      allTests: () =>
        tests.map((t) => ({ fullName: t.fullName, annotations: () => t.annotations })),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Runs the reporter over one module; the exit code it leaves and what it wrote to stderr. */
function run(tests: { fullName: string; annotations: unknown[] }[]): {
  exitCode: typeof process.exitCode;
  stderr: string;
} {
  const before = process.exitCode;
  let stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  const reporter = new StrictSmokeReporter();
  process.exitCode = undefined;
  try {
    reporter.onTestModuleEnd(moduleOf(tests));
    reporter.onTestRunEnd();
    return { exitCode: process.exitCode, stderr };
  } finally {
    process.exitCode = before;
  }
}

it('[F1-01k] passes when the diagnostics hold only requests the test blocked itself', () => {
  expect(
    smokeDiagnosticsFindings({ entry: 'admin', url: URL_, diagnostics: BLOCKED_ONLY }),
  ).toEqual([]);
  const result = run([
    {
      fullName: 'admin 首屏',
      annotations: [SCREENSHOT, diagnosticsAnnotation('admin', BLOCKED_ONLY)],
    },
    // Size and artifact tests open no page: nothing to read.
    { fullName: 'landing 体积', annotations: [] },
  ]);
  expect(result.exitCode).toBeUndefined();
  expect(result.stderr).toBe('');
});

it('[F1-01k] a page error fails the run and names the test, the entry and the message', () => {
  const result = run([
    {
      fullName: '[AC-F1-01k-SMOKE#1] app 应用壳与截图',
      annotations: [
        diagnosticsAnnotation('app', [
          ...BLOCKED_ONLY,
          {
            kind: 'pageerror',
            message:
              "TypeError: Cannot read properties of undefined (reading 'x')\n    at y.js:1:2",
          },
        ]),
      ],
    },
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('[build-smoke strict] 1 page problem(s)');
  expect(result.stderr).toContain(
    "[AC-F1-01k-SMOKE#1] app 应用壳与截图 — app: the page threw: TypeError: Cannot read properties of undefined (reading 'x')",
  );
  // Green means green: not even the skeleton's NotImplemented is excused here.
  expect(
    smokeDiagnosticsFindings({
      url: URL_,
      diagnostics: [{ kind: 'pageerror', message: 'Error: NotImplemented: AdminShell' }],
    }),
  ).toEqual(['the page threw: Error: NotImplemented: AdminShell']);
});

it('[F1-01k] a failed own request or lazy chunk fails the run; other hosts and plain console output do not', () => {
  const f = (diagnostics: Diagnostic[]): string[] =>
    smokeDiagnosticsFindings({ url: URL_, diagnostics });
  expect(
    f([{ kind: 'requestfailed', message: `${URL_}assets/page-D5e6.js: net::ERR_FAILED` }]),
  ).toEqual([`a request of the entry failed: ${URL_}assets/page-D5e6.js: net::ERR_FAILED`]);
  expect(
    f([
      {
        kind: 'console.error',
        message: `TypeError: Failed to fetch dynamically imported module: ${URL_}assets/p.js`,
      },
    ]),
  ).toEqual([
    `a module of the page did not load: TypeError: Failed to fetch dynamically imported module: ${URL_}assets/p.js`,
  ]);
  expect(
    f([{ kind: 'requestfailed', message: 'https://cdn.invalid/a.js: net::ERR_FAILED' }]),
  ).toEqual([]);
  expect(f([{ kind: 'console.error', message: 'Warning: something' }])).toEqual([]);
  // Unreadable: fail closed.
  expect(f([{ kind: 'requestfailed', message: 'not a url' }])).toHaveLength(1);
  expect(smokeDiagnosticsFindings({ entry: 'x' })).toEqual([
    'diagnostics annotation without a readable diagnostics list',
  ]);
  // A plain (not base64) JSON body is read as it is; other annotations are ignored.
  expect(
    testCaseFindings([
      SCREENSHOT,
      { message: 'other', type: 'notice' },
      diagnosticsAnnotation('landing', [{ kind: 'pageerror', message: 'Error: boom' }], false),
    ]),
  ).toEqual(['landing: the page threw: Error: boom']);
  expect(testCaseFindings(undefined)).toEqual([]);
});

it('[F1-01k] a script error the page only logged fails the run, NotImplemented included (Codex r3, S1 ②)', () => {
  const f = (message: string): string[] =>
    smokeDiagnosticsFindings({ url: URL_, diagnostics: [{ kind: 'console.error', message }] });
  const stack = `\n    at Xe (${URL_}assets/index-E7f8.js:9:1234)`;
  const RR = 'React Router caught the following error during render ';
  // React Router's errorElement catches a render error: no pageerror, only this console.error.
  expect(f(`${RR}TypeError: Cannot read properties of undefined (reading 'map')${stack}`)).toEqual([
    `the page logged a script error: ${RR}TypeError: Cannot read properties of undefined (reading 'map')`,
  ]);
  // Green means green: the skeleton's NotImplemented is not excused here either.
  expect(f(`${RR}Error: NotImplemented: AppShell${stack}`)).toEqual([
    `the page logged a script error: ${RR}Error: NotImplemented: AppShell`,
  ]);
  for (const message of [
    'ReferenceError: t is not defined',
    'Uncaught SyntaxError: Unexpected identifier',
    'RangeError: Invalid time value',
    `Error: wrapped${stack}\nCaused by: TypeError: x`,
  ]) {
    expect(f(message), message).toHaveLength(1);
  }
  // Blocked loads and warnings stay evidence only.
  expect(f('Failed to load resource: net::ERR_BLOCKED_BY_CLIENT')).toEqual([]);
  expect(f('Warning: something')).toEqual([]);
  const result = run([
    {
      fullName: '[AC-F1-01k-SMOKE#1] app 应用壳与截图',
      annotations: [
        diagnosticsAnnotation('app', [
          ...BLOCKED_ONLY,
          { kind: 'console.error', message: `${RR}TypeError: x is not a function${stack}` },
        ]),
      ],
    },
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(
    `[AC-F1-01k-SMOKE#1] app 应用壳与截图 — app: the page logged a script error: ${RR}TypeError: x is not a function`,
  );
});
