import { unitConfig } from '../vitest.shared.ts';

// Browser rule tests run only in a real Chromium (vitest.browser.config.ts, `test:browser`).
export default unitConfig(
  ['properties/**/*.test.ts', 'spec/**/*.test.ts'],
  ['spec/**/*.browser.test.{ts,tsx}'],
);
