import { unitConfig } from '../vitest.shared.ts';

// Browser rule tests run only in a real Chromium (vitest.browser.config.ts, `test:browser`); build
// smoke tests only against the built entries (vitest.build-smoke.config.ts, `test:smoke`).
export default unitConfig(
  ['properties/**/*.test.ts', 'spec/**/*.test.ts'],
  ['spec/**/*.browser.test.{ts,tsx}', 'spec/**/*.smoke.test.ts'],
);
