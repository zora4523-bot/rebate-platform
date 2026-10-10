import { unitConfig } from '../vitest.shared.ts';

// Browser rule tests run only in a real Chromium (vitest.browser.config.ts, `test:browser`); build
// smoke tests only against the built entries (vitest.build-smoke.config.ts, `test:smoke`).
const base = unitConfig(
  ['properties/**/*.test.ts', 'spec/**/*.test.ts'],
  ['spec/**/*.browser.test.{ts,tsx}', 'spec/**/*.smoke.test.ts'],
);

// F1-06za: per-test timeout 15 s instead of Vitest's 5 s default. Plan 03 §9.1 requires the admin
// to use antd components; antd's CSS-in-JS injects large style sheets, and jsdom's
// getComputedStyle (called by user-event on every pointer / keyboard action) slows down with
// them: on CI the admin login rule test [AC-F1-06h-UI#3] took 5.48 s (#385). Assertions are
// unchanged; only the timeout is raised.
export default { ...base, test: { ...base.test, testTimeout: 15_000 } };
