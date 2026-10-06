// Helpers of the trusted red reporter (F1-01j): where a failing call was made, and whether a test
// file uses expect.poll. The stack texts are those of a real red run in the verify image
// (2026-10-06, F1-01j red/1, cut to the frames that matter).
import { expect, it } from 'vitest';
import RedReporter, {
  annotationRecord,
  attachmentText,
  frameFile,
  pollInCode,
  userSite,
} from './red-reporter.mjs';

const TEST = '/work/repo/test/spec/frontend/browser-env/demo-red.browser.test.ts';
const DEPS = '/work/repo/test/node_modules/.vite/vitest/da39a3ee/deps/index.m3L2HgmY-ClFbRdXj.js';
const RAW_POLL_STACK = [
  "Error: Cannot find element with locator: getByText('不会出现的文字')",
  '    at Proxy.__VITEST_POLL_CHAIN__ (http://localhost:63315/node_modules/.vite/vitest/da39a3ee/deps/index.m3L2HgmY-ClFbRdXj.js?v=b6c384b3:5767:47)',
  `    at http://localhost:63315${TEST}?import&browserv=1791261813481:8:68`,
  '    at new Promise (<anonymous>)',
  '    at runWithTimeout (http://localhost:63315/node_modules/.vite/vitest/da39a3ee/deps/plugins.Cigb0uSy-Dj1mblMG.js?v=b6c384b3:5388:10)',
].join('\n');

it('[F1-01j] frame files lose the browser origin, file:// and /@fs prefixes and the query', () => {
  expect(frameFile(`http://localhost:63315${TEST}?import&browserv=1`)).toBe(TEST);
  expect(frameFile(`file://${TEST}`)).toBe(TEST);
  expect(frameFile(`/@fs${TEST}?v=1`)).toBe(TEST);
  // Another origin is not the container's own page: left as it is.
  expect(frameFile(`https://example.invalid${TEST}`)).toBe(`https://example.invalid${TEST}`);
});

it('[F1-01j] the site is the first frame outside the dependencies, parsed stack first', () => {
  // The real shape: Vitest's parsed stack starts with the pre-bundled poll frame.
  expect(
    userSite({
      stacks: [
        { file: `${DEPS}?v=b6c384b3`, line: 5767, column: 47 },
        { file: TEST, line: 10, column: 3 },
      ],
      stack: RAW_POLL_STACK,
    }),
  ).toEqual({ file: TEST, line: 10, column: 3 });
  // Only the dependency frame was parsed: the raw stack text has the test file next.
  const depsOnly = { stacks: [{ file: DEPS, line: 5767, column: 47 }], stack: RAW_POLL_STACK };
  expect(userSite(depsOnly)).toEqual({ file: TEST, line: 8, column: 68 });
  // A helper module that started the wait is the site, not the test file further down.
  const kit = '/work/repo/test/spec/frontend/browser-env/kit.ts';
  expect(
    userSite({
      stacks: [
        { file: DEPS, line: 1, column: 1 },
        { file: kit, line: 4, column: 9 },
        { file: TEST, line: 8, column: 3 },
      ],
    }),
  ).toEqual({ file: kit, line: 4, column: 9 });
  // Nothing but dependencies, or nothing at all: no site.
  expect(userSite({ stacks: [{ file: DEPS, line: 1, column: 1 }], stack: 'Error: x' })).toBeNull();
  expect(userSite(null)).toBeNull();
});

it('[F1-01j] expect.poll in the code counts; poll in element texts, strings and comments does not', () => {
  const element = [
    '// waits for the poll button (a comment, not code)',
    '/* expect.poll(() => x) in a block comment */',
    "await expect.element(page.getByRole('button', { name: 'poll' })).toBeVisible();",
    'await expect.element(page.getByText("start poll now")).toBeVisible();',
    'const label = `poll ${count} times`;',
  ].join('\n');
  expect(pollInCode(element)).toBe(false);
  for (const code of [
    'await expect.poll(() => read()).toBe(1);',
    'await expect\n  .poll(() => read())\n  .toBe(1);',
    "await expect['poll'](() => read()).toBe(1);",
    'const { poll } = expect;',
    'const label = `waiting ${expect.poll(() => read())}`;',
  ]) {
    expect(pollInCode(code), code).toBe(true);
  }
});

// F1-01k: the build smoke rule tests annotate each entry with a JSON body (page errors, failed
// requests); vitest 5.0.1 labels a plain string body base64 (manageArtifactAttachment).
const DIAGNOSTICS = {
  entry: 'app',
  url: 'http://127.0.0.1:40124/',
  diagnostics: [{ kind: 'pageerror', message: 'TypeError: boom' }],
};

it('[F1-01k] attachment bodies: plain JSON as it is, base64 decoded, binary as UTF-8', () => {
  const json = JSON.stringify(DIAGNOSTICS, null, 2);
  expect(attachmentText({ body: json, bodyEncoding: 'base64' })).toBe(json);
  expect(attachmentText({ body: json, bodyEncoding: 'utf-8' })).toBe(json);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  expect(attachmentText({ body: b64, bodyEncoding: 'base64' })).toBe(json);
  expect(attachmentText({ body: new TextEncoder().encode(json) })).toBe(json);
  expect(attachmentText({ path: '/a.png' })).toBeNull();
  expect(attachmentText(null)).toBeNull();
});

it('[F1-01k] annotations keep message, type, content type, path and a JSON body parsed', () => {
  expect(
    annotationRecord({
      message: 'app 浏览器诊断（不作为断言）',
      type: 'notice',
      attachment: {
        body: JSON.stringify(DIAGNOSTICS),
        bodyEncoding: 'base64',
        contentType: 'application/json',
      },
    }),
  ).toEqual({
    message: 'app 浏览器诊断（不作为断言）',
    type: 'notice',
    content_type: 'application/json',
    json: DIAGNOSTICS,
  });
  expect(
    annotationRecord({
      message: 'app 首屏截图',
      type: 'notice',
      attachment: { path: '/work/repo/test/.vitest/attachments/x.png', contentType: 'image/png' },
    }),
  ).toEqual({
    message: 'app 首屏截图',
    type: 'notice',
    content_type: 'image/png',
    path: '/work/repo/test/.vitest/attachments/x.png',
  });
  // A text body that is not JSON is not kept.
  expect(
    annotationRecord({ message: 'm', type: 'notice', attachment: { body: 'plain text!' } }),
  ).toEqual({ message: 'm', type: 'notice' });
  expect(annotationRecord(undefined)).toEqual({ message: '', type: '' });
});

it('[F1-01k] every test of the report carries its annotations', () => {
  const reporter = new RedReporter();
  const testCase = {
    fullName: 'entries > app',
    name: 'app',
    result: () => ({ state: 'failed', errors: [] }),
    annotations: () => [
      {
        message: 'app 浏览器诊断（不作为断言）',
        type: 'notice',
        attachment: { body: JSON.stringify(DIAGNOSTICS), bodyEncoding: 'base64' },
      },
    ],
  };
  const noAnnotations = { ...testCase, name: 'budget', annotations: undefined };
  reporter.onTestModuleEnd({
    moduleId: '/nonexistent/entries.smoke.test.ts',
    errors: () => [],
    state: () => 'failed',
    project: { config: {} },
    children: { allTests: () => [testCase, noAnnotations] },
  });
  const [file] = reporter.files as { assertionResults: { annotations: unknown }[] }[];
  expect(file?.assertionResults.map((t) => t.annotations)).toEqual([
    [{ message: 'app 浏览器诊断（不作为断言）', type: 'notice', json: DIAGNOSTICS }],
    [],
  ]);
});
