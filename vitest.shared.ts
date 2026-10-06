// Shared Vitest configuration for every workspace package (conventions C5).
// Protected path, class 2 (verify config): changing it needs owner approval (规划/11 §4.4).
import { defaultClientConditions, defaultServerConditions } from 'vite';
import { configDefaults, type ViteUserConfig } from 'vitest/config';

// Workspace packages expose their TypeScript sources through the custom export condition
// `couli-src`, so tests never need a prior build. Vite's own server conditions are kept.
const CONDITIONS: string[] = ['couli-src', ...defaultServerConditions];
// Browser tests load modules the way the H5 build does (apps/h5/vite.config.ts): client
// conditions plus `couli-src`.
const BROWSER_CONDITIONS: string[] = ['couli-src', ...defaultClientConditions];

const BASE_EXCLUDE: string[] = [...configDefaults.exclude, '**/dist/**', '**/.tmp/**'];

// Same strictness for every tier: an empty run, `.only`, retries and assertion-free tests fail.
const STRICT = {
  passWithNoTests: false,
  allowOnly: false,
  retry: 0,
  expect: { requireAssertions: true },
} as const;

function resolveBlock(): Pick<ViteUserConfig, 'resolve' | 'ssr'> {
  return {
    resolve: { conditions: [...CONDITIONS] },
    ssr: { resolve: { conditions: [...CONDITIONS] } },
  };
}

/**
 * Unit tests: no database, no ports, no network. Integration files are excluded, and so is
 * `exclude` (test/vitest.config.ts: the browser rule tests, which only browserConfig runs).
 */
export function unitConfig(
  include: string[] = ['src/**/*.test.ts'],
  exclude: string[] = [],
): ViteUserConfig {
  return {
    ...resolveBlock(),
    test: {
      ...STRICT,
      include,
      exclude: [...BASE_EXCLUDE, '**/*.int.test.ts', ...exclude],
    },
  };
}

type BrowserOptions = NonNullable<NonNullable<ViteUserConfig['test']>['browser']>;

/**
 * Browser tests (`*.browser.test.{ts,tsx}`): Vitest browser mode in a real headless Chromium. The
 * provider and the Vite plugins come from the caller (test/vitest.browser.config.ts), whose
 * package depends on them. Screenshots of `page.screenshot()` (and of failures) go to
 * `screenshotDirectory`; `fsAllow` lists extra directories the page may read back through
 * `commands.readFile` (an export directory outside the repository).
 */
export function browserConfig(opts: {
  include: string[];
  plugins: NonNullable<ViteUserConfig['plugins']>;
  provider: NonNullable<BrowserOptions['provider']>;
  screenshotDirectory: string;
  fsAllow?: string[];
}): ViteUserConfig {
  return {
    resolve: { conditions: [...BROWSER_CONDITIONS] },
    plugins: opts.plugins,
    ...(opts.fsAllow === undefined ? {} : { server: { fs: { allow: [...opts.fsAllow] } } }),
    test: {
      ...STRICT,
      include: opts.include,
      exclude: [...BASE_EXCLUDE],
      browser: {
        enabled: true,
        provider: opts.provider,
        headless: true,
        instances: [{ browser: 'chromium' }],
        screenshotDirectory: opts.screenshotDirectory,
      },
    },
  };
}

/** Integration tests (`*.int.test.ts`): need PostgreSQL; run only by `test:int`. */
export function integrationConfig(opts: {
  include?: string[];
  globalSetup: string[];
}): ViteUserConfig {
  return {
    ...resolveBlock(),
    test: {
      ...STRICT,
      include: opts.include ?? ['src/**/*.int.test.ts'],
      exclude: [...BASE_EXCLUDE],
      globalSetup: opts.globalSetup,
      testTimeout: 60_000,
      hookTimeout: 180_000,
    },
  };
}

/** Long-run property tier; per-test timeout is 10 minutes (规划/11 §4.2). */
export function longrunConfig(include: string[]): ViteUserConfig {
  return {
    ...resolveBlock(),
    test: {
      ...STRICT,
      include,
      exclude: [...BASE_EXCLUDE],
      testTimeout: 600_000,
    },
  };
}
