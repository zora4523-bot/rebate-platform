// Browser tests (`test:browser`): Vitest browser mode in a real headless Chromium through
// Playwright (F1-01j). Same plugins and module conditions as apps/h5/vite.config.ts, the strict
// settings of vitest.shared.ts. tools/ops/verify-image/red-projects.json (project spec-browser)
// mirrors the include rule below; tools/ops/red-plan.test.ts checks that they agree.
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { browserConfig } from '../vitest.shared.ts';

const INCLUDE = ['spec/**/*.browser.test.ts'];

// Where `page.screenshot()` writes: the git-ignored test/.tmp/ by default; an export directory
// when COULI_BROWSER_SCREENSHOT_DIR names one (tools/ops/verify-container.sh --browser sets it
// to /out/screenshots). The page reads its screenshots back, so that directory is allowed.
const exportDir = process.env['COULI_BROWSER_SCREENSHOT_DIR'];
const screenshots = exportDir === undefined || exportDir === '' ? undefined : resolve(exportDir);

export default browserConfig({
  include: INCLUDE,
  plugins: [react(), tailwindcss()],
  provider: playwright(),
  screenshotDirectory: screenshots ?? '.tmp/browser/screenshots',
  ...(screenshots === undefined ? {} : { fsAllow: [screenshots] }),
});
