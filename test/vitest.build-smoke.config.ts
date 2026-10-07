// Build smoke (`test:smoke`, F1-01k): the globalSetup builds the H5 entries (APP_ENV=test) and the
// admin console into a temporary directory and serves each on 127.0.0.1; the rule tests open them
// in the image's Chromium through the `playwright` library, check the first screen and the size
// budgets, and export one screenshot per entry (COULI_BROWSER_SCREENSHOT_DIR, else
// test/.tmp/build-smoke/screenshots/). tools/ops/verify-image/red-projects.json (project
// build-smoke) mirrors the include rule below; tools/ops/red-plan.test.ts checks that they agree.
//
// The strict reporter (tools/ops/build-smoke/strict-reporter.mjs) fails the run when the browser
// diagnostics the tests attach show an uncaught page error, a failed request of the entry's own
// origin that the test did not block, or a module that did not load: the tests themselves only
// collect them. A `--reporter` on the command line replaces both reporters (the isolated red run
// uses its own; verify-container.sh --browser passes this one again).
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vitest/config';
import { smokeConfig } from '../vitest.shared.ts';

const STRICT_REPORTER = fileURLToPath(
  new URL('../tools/ops/build-smoke/strict-reporter.mjs', import.meta.url),
);

export default mergeConfig(
  smokeConfig({
    include: ['spec/**/*.smoke.test.ts'],
    globalSetup: ['../tools/ops/build-smoke/global-setup.ts'],
  }),
  { test: { reporters: ['default', STRICT_REPORTER] } },
);
