// Helpers of the trusted red reporter (F1-01j): where a failing call was made, and whether a test
// file uses expect.poll. The stack texts are those of a real red run in the verify image
// (2026-10-06, F1-01j red/1, cut to the frames that matter).
import { expect, it } from 'vitest';
import { frameFile, pollInCode, userSite } from './red-reporter.mjs';

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
