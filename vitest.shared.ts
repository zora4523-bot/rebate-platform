// Shared Vitest configuration for every workspace package (conventions C5).
// Protected path, class 2 (verify config): changing it needs owner approval (规划/11 §4.4).
import { defaultClientConditions, defaultServerConditions, type Plugin } from 'vite';
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
 * Browser tests only (CT-06zi): a warning for every module request of the test pages (requests
 * with `Sec-Fetch-Dest: script`) that does not end in a success. A test file that fails with
 * "Failed to fetch dynamically imported module" names only the root of its import graph; this
 * line names the request that failed and how: an error status (Vite answers an outdated
 * pre-bundled dependency with a bare 504 and logs nothing), a success that is not JavaScript
 * (the browser refuses such a module), or a connection closed before the response was complete.
 * The first module request of a run also logs one line, so a run without failure lines shows
 * that the log was on. It only observes: no request or response is changed.
 */
function moduleRequestLog(): Plugin {
  let seen = false;
  return {
    name: 'couli:browser-module-request-log',
    configureServer(server) {
      const warn = (message: string): void => {
        server.config.logger.warn(`[browser tests] ${message}`, { timestamp: true });
      };
      server.middlewares.use((req, res, next) => {
        if (req.headers['sec-fetch-dest'] === 'script') {
          if (!seen) {
            seen = true;
            const pw = process.env['VITEST_PW_DEBUG'] ?? '';
            warn(`module request log on (VITEST_PW_DEBUG=${pw}), first module request: ${req.url}`);
          }
          res.once('close', () => {
            const type = String(res.getHeader('content-type') ?? '');
            let outcome: string | undefined;
            if (!res.writableFinished) outcome = 'closed before the response was complete';
            else if (res.statusCode >= 400) outcome = `${res.statusCode} ${res.statusMessage}`;
            else if (res.statusCode < 300 && !type.includes('javascript')) {
              outcome = `${res.statusCode} with content type "${type}"`;
            }
            if (outcome !== undefined) warn(`module request ${outcome}: ${req.url}`);
          });
        }
        next();
      });
    },
  };
}

/**
 * Browser tests (`*.browser.test.{ts,tsx}`): Vitest browser mode in a real headless Chromium. The
 * provider and the Vite plugins come from the caller (test/vitest.browser.config.ts), whose
 * package depends on them; the module request log above is added after them. Screenshots of
 * `page.screenshot()` (and of failures) go to `screenshotDirectory`; `fsAllow` lists extra
 * directories the page may read back through `commands.readFile` (an export directory outside
 * the repository).
 *
 * CT-06zi, the browser side of that log: VITEST_PW_DEBUG makes @vitest/browser-playwright print
 * every request the page itself reports as failed ("[PW Error] <type> request failed for <url>
 * url: <net error>"), including ones that never reached the server. The provider reads the
 * variable when it opens a page, after this config is loaded; a value set by the caller is kept.
 * Requests to the fixtures' unreachable hosts (images of *.example.test and the like) show up
 * there too.
 */
export function browserConfig(opts: {
  include: string[];
  plugins: NonNullable<ViteUserConfig['plugins']>;
  provider: NonNullable<BrowserOptions['provider']>;
  screenshotDirectory: string;
  fsAllow?: string[];
}): ViteUserConfig {
  process.env['VITEST_PW_DEBUG'] ??= '1';
  return {
    resolve: { conditions: [...BROWSER_CONDITIONS] },
    plugins: [...opts.plugins, moduleRequestLog()],
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

/**
 * Build smoke (`*.smoke.test.ts`, F1-01k): Node tests against production builds that the
 * `globalSetup` makes and serves on the loopback (tools/ops/build-smoke/global-setup.ts); the
 * tests drive the image's Chromium through the `playwright` library. Builds take minutes, and the
 * one browser per test makes several tests at once pointless: files run one after another.
 */
export function smokeConfig(opts: { include: string[]; globalSetup: string[] }): ViteUserConfig {
  return {
    ...resolveBlock(),
    test: {
      ...STRICT,
      include: opts.include,
      exclude: [...BASE_EXCLUDE],
      environment: 'node',
      globalSetup: opts.globalSetup,
      fileParallelism: false,
      testTimeout: 60_000,
      hookTimeout: 60_000,
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
