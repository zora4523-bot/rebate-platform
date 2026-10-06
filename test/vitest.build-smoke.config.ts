// Build smoke (`test:smoke`, F1-01k): the globalSetup builds the H5 entries (APP_ENV=test) and the
// admin console into a temporary directory and serves each on 127.0.0.1; the rule tests open them
// in the image's Chromium through the `playwright` library, check the first screen and the size
// budgets, and export one screenshot per entry (COULI_BROWSER_SCREENSHOT_DIR, else
// test/.tmp/build-smoke/screenshots/). tools/ops/verify-image/red-projects.json (project
// build-smoke) mirrors the include rule below; tools/ops/red-plan.test.ts checks that they agree.
import { smokeConfig } from '../vitest.shared.ts';

export default smokeConfig({
  include: ['spec/**/*.smoke.test.ts'],
  globalSetup: ['../tools/ops/build-smoke/global-setup.ts'],
});
