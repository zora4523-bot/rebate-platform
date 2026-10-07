import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium, type Locator, type Page } from 'playwright';
import { expect, inject, it, type TestContext } from 'vitest';
import type { BuildSmokeEntries } from '../../../../tools/ops/build-smoke/types.ts';

// This suite consumes builds and servers owned by globalSetup. No builds, listeners or
// application-source imports here. Bootstrap red is demonstrated in the reviewed candidate
// copy; an exception from globalSetup itself is infrastructure failure, never valid red.
type EntryName = keyof BuildSmokeEntries;

function entries(): BuildSmokeEntries {
  const provided = inject('buildSmoke');
  expect(provided, 'globalSetup must provide buildSmoke').toBeDefined();
  expect(Object.keys(provided.entries).sort()).toEqual(['admin', 'app', 'conformance', 'landing']);
  return provided.entries;
}

function screenshotDirectory(): string {
  const configured = process.env['COULI_BROWSER_SCREENSHOT_DIR'];
  return configured === undefined || configured === ''
    ? fileURLToPath(new URL('../../../.tmp/build-smoke/screenshots/', import.meta.url))
    : resolve(configured);
}

async function visible(locator: Locator): Promise<void> {
  // Keep Playwright's original TimeoutError: only locator.waitFor timeouts are valid red.
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  expect(await locator.isVisible()).toBe(true);
}

type Diagnostic = { kind: string; message: string };

/**
 * Heading of the H5 load-failure page React Router's errorElement shows when a route's lazy
 * import or its render fails (apps/h5/src/components/retry/retry-page.tsx: role="alert" with an
 * h1 of contracts/texts.default.json h5.load_failed; apps/h5/src/entries/app/routes.ts).
 */
const ROUTE_ERROR_HEADING = '页面加载失败，请重试';

/**
 * Collects, before any page script runs, what a page swallows without a console.error or a
 * pageerror (F1-01m): Vite's `vite:preloadError` (its preload helper dispatches it with the
 * rejected import as `payload` when a lazy chunk or one of its dependencies fails to load or to
 * initialise, then rethrows unless prevented — never prevented here) and `unhandledrejection`.
 * Runs in the page: it must not close over anything.
 */
function installSwallowedErrorCollector(): void {
  const found: { kind: string; message: string }[] = [];
  Object.defineProperty(window, '__couliSmokeDiag', { value: found, enumerable: false });
  const describeValue = (value: unknown): string => {
    try {
      if (value instanceof Error) {
        const rest = (value.stack ?? '').split('\n').slice(1).join('\n');
        return rest === '' ? String(value) : `${String(value)}\n${rest}`;
      }
      return String(value);
    } catch {
      return '(unreadable value)';
    }
  };
  window.addEventListener('vite:preloadError', (event) => {
    found.push({
      kind: 'preload-error',
      message: describeValue((event as Event & { payload?: unknown }).payload),
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    found.push({ kind: 'unhandled-rejection', message: describeValue(event.reason) });
  });
}

/**
 * Reads back what installSwallowedErrorCollector gathered and whether the route error page is
 * showing (`route-error`); never throws. When the page cannot be read (closed, hung) the
 * diagnostics say so (`diagnostics-incomplete`): the page events are then not fully known.
 */
async function collectSwallowedErrors(page: Page, diagnostics: Diagnostic[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = page.evaluate((heading) => {
      const own = (window as unknown as { __couliSmokeDiag?: unknown }).__couliSmokeDiag;
      const collected = Array.isArray(own) ? (own as { kind: string; message: string }[]) : null;
      const routeError = [...document.querySelectorAll('[role="alert"]')].some((alert) =>
        [...alert.querySelectorAll('h1')].some((h1) => h1.textContent?.trim() === heading),
      );
      return { collected, routeError, path: location.pathname };
    }, ROUTE_ERROR_HEADING);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('reading the page timed out (5000ms)')), 5_000);
    });
    const { collected, routeError, path } = await Promise.race([read, timeout]);
    if (collected === null) {
      diagnostics.push({
        kind: 'diagnostics-incomplete',
        message: 'the swallowed-error collector was not installed in the page',
      });
    } else {
      diagnostics.push(...collected);
    }
    if (routeError) {
      diagnostics.push({
        kind: 'route-error',
        message: `the route error page (RetryPage "${ROUTE_ERROR_HEADING}") is showing at ${path}`,
      });
    }
  } catch (error) {
    diagnostics.push({
      kind: 'diagnostics-incomplete',
      message: `the page could not be read: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function firstScreen(
  name: EntryName,
  context: TestContext,
  check: (page: Page) => Promise<void>,
): Promise<void> {
  const entry = entries()[name];
  const entryUrl = new URL(entry.url);
  expect(entryUrl.hostname, `${name}: loopback preview only`).toBe('127.0.0.1');
  expect(entryUrl.protocol).toBe('http:');
  const browser = await chromium.launch();
  try {
    const browserContext = await browser.newContext({
      viewport: name === 'admin' ? { width: 1440, height: 900 } : { width: 375, height: 812 },
      serviceWorkers: 'block',
    });
    const page = await browserContext.newPage();
    const diagnostics: Diagnostic[] = [];
    await page.addInitScript(installSwallowedErrorCollector);
    page.on('pageerror', (error) => {
      diagnostics.push({ kind: 'pageerror', message: error.stack ?? error.message });
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        diagnostics.push({ kind: 'console.error', message: message.text() });
      }
    });
    page.on('requestfailed', (request) => {
      diagnostics.push({
        kind: 'requestfailed',
        message: `${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`,
      });
    });
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      // No first screen needs an API yet; in particular the admin permission endpoint is
      // deliberately unavailable (CT-02f). Do not invent a response outside the contracts.
      if (
        url.origin !== entryUrl.origin ||
        /^\/(?:admin\/)?v1(?:\/|$)/.test(url.pathname) ||
        !['GET', 'HEAD'].includes(request.method())
      ) {
        diagnostics.push({ kind: 'blocked-request', message: request.url() });
        await route.abort('blockedbyclient');
      } else {
        await route.continue();
      }
    });
    await page.routeWebSocket('**/*', (socket) => {
      diagnostics.push({ kind: 'blocked-websocket', message: socket.url() });
      socket.close();
    });
    try {
      // App has no index route. /rules is an actual H5 route from contracts/routes.json;
      // navigating directly also exercises the preview server's SPA fallback.
      const target = name === 'app' ? new URL('/rules', entryUrl).href : entry.url;
      await page.goto(target, { waitUntil: 'load', timeout: 15_000 });
      await check(page);
    } finally {
      await collectSwallowedErrors(page, diagnostics);
      try {
        const directory = screenshotDirectory();
        mkdirSync(directory, { recursive: true });
        const screenshot = resolve(directory, `smoke-${name}.png`);
        await page.screenshot({ path: screenshot, fullPage: false, timeout: 10_000 });
        await context.annotate(`${name} 首屏截图`, { path: screenshot, contentType: 'image/png' });
      } finally {
        // Script and network errors are evidence for the reviewer/red classifier, not
        // AssertionErrors. Never turn launch/goto/net::ERR_* into valid assertion red.
        await context.annotate(`${name} 浏览器诊断（不作为断言）`, {
          body: JSON.stringify({ entry: name, url: entry.url, diagnostics }, null, 2),
          contentType: 'application/json',
        });
      }
    }
  } finally {
    await browser.close();
  }
}

it('[AC-F1-01k-SMOKE#1] app 应用壳与截图', { timeout: 45_000 }, async (context) => {
  await firstScreen('app', context, async (page) => {
    const main = page.getByRole('main');
    await visible(main);
    // apps/h5/src/texts/shell.ts: h5.shell.page_pending.
    await visible(main.getByText('页面暂未开放', { exact: true }));
  });
});

it('[AC-F1-01k-SMOKE#2] landing 引导内容与截图', { timeout: 45_000 }, async (context) => {
  await firstScreen('landing', context, async (page) => {
    const main = page.getByRole('main');
    await visible(main);
    await visible(main.getByText('页面暂未开放', { exact: true }));
  });
});

it('[AC-F1-01k-SMOKE#3] conformance 用例列表与截图', { timeout: 45_000 }, async (context) => {
  await firstScreen('conformance', context, async (page) => {
    // Current conformance-shell.tsx has no heading or table: its case catalogue is a list
    // of buttons labelled with case IDs. Native probe results are outside this smoke test.
    const main = page.getByRole('main');
    await visible(main);
    await visible(main.getByRole('list'));
    await visible(main.getByRole('button', { name: 'auth.login/normal', exact: true }));
    await visible(main.getByRole('button', { name: 'share.open/normal', exact: true }));
  });
});

it('[AC-F1-01k-SMOKE#4] 后台登录第一步与截图', { timeout: 45_000 }, async (context) => {
  await firstScreen('admin', context, async (page) => {
    // AdmLogin copy for apps/admin/src/texts/login.ts (currently a NotImplemented skeleton).
    await visible(page.getByRole('heading', { name: '请使用后台账号登录', exact: true }));
    await visible(page.getByLabel(/^账号\s*\*?$/));
    await visible(page.getByLabel(/^密码\s*\*?$/));
    await visible(page.getByRole('button', { name: '下一步', exact: true }));
  });
});

function readArtifact(distDir: string, filename: string): Buffer {
  const path = resolve(distDir, filename);
  const within = relative(resolve(distDir), path);
  expect(isAbsolute(within) || within === '..' || within.startsWith('../'), filename).toBe(false);
  expect(existsSync(path), `missing build artifact: ${path}`).toBe(true);
  return readFileSync(path);
}

function initialScripts(entry: BuildSmokeEntries[EntryName]): string[] {
  const html = readArtifact(entry.distDir, 'index.html')
    .toString('utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
  const files = new Set<string>();
  // Vite emits quoted HTML attributes. Match either order/quote style and deduplicate a
  // chunk referenced by both script and modulepreload; do not traverse dynamic imports.
  for (const tag of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const attr of tag[0].matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)) {
      attrs.set(attr[1]!.toLowerCase(), attr[3]!);
    }
    const script = tag[1]!.toLowerCase() === 'script' && attrs.get('type') === 'module';
    const preload =
      tag[1]!.toLowerCase() === 'link' &&
      attrs.get('rel')?.toLowerCase().split(/\s+/).includes('modulepreload');
    if (!script && !preload) continue;
    const source = attrs.get(script ? 'src' : 'href');
    if (source === undefined) continue;
    const url = new URL(source, new URL('/index.html', entry.url));
    expect(url.origin, `initial module must be local: ${source}`).toBe(new URL(entry.url).origin);
    files.add(decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  }
  expect(files.size, 'initial script list must not be empty').toBeGreaterThan(0);
  return [...files].sort();
}

it.each([
  ['landing', 60 * 1024],
  ['app', 150 * 1024],
] as const)('[AC-F1-01k-SIZE#1] %s 初始 JS gzip 不超过 %i 字节', (name, budget) => {
  const entry = entries()[name];
  const measured = initialScripts(entry).map((file) => ({
    file,
    bytes: gzipSync(readArtifact(entry.distDir, file)).byteLength,
  }));
  const bytes = measured.reduce((total, file) => total + file.bytes, 0);
  expect(
    bytes,
    `${name}: 实测 ${bytes} 字节，预算 ${budget} 字节；文件 ${JSON.stringify(measured)}`,
  ).toBeLessThanOrEqual(budget);
});

function javascriptFiles(distDir: string): string[] {
  expect(existsSync(distDir), `missing build directory: ${distDir}`).toBe(true);
  const files = readdirSync(distDir, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.[cm]?js$/.test(name))
    .sort();
  expect(files.length, `JS artifacts in ${distDir}`).toBeGreaterThan(0);
  return files;
}

it('[AC-F1-01k-BUILD#1] app 与后台所有 JS 产物不包含开发 JSX 运行时', () => {
  const built = entries();
  for (const name of ['app', 'admin'] as const) {
    const { distDir } = built[name];
    for (const file of javascriptFiles(distDir)) {
      const source = readArtifact(distDir, file).toString('utf8');
      expect(source, `${name}/${file}: production JSX`).not.toContain('jsxDEV');
    }
  }
});

it('[AC-F1-01k-BUILD#2] conformance 测试产物独立，不混入业务入口', () => {
  const built = entries();
  expect(new Set(Object.values(built).map((entry) => resolve(entry.distDir))).size).toBe(4);
  const sources = Object.fromEntries(
    Object.entries(built).map(([name, entry]) => [
      name,
      javascriptFiles(entry.distDir)
        .map((file) => readArtifact(entry.distDir, file).toString('utf8'))
        .join('\n'),
    ]),
  );
  // Stable probe ID from the existing conformance case catalogue; not a minified symbol.
  expect(sources['conformance']).toContain('conformance.notAMethod');
  for (const name of ['app', 'landing', 'admin'] as const) {
    expect(sources[name], `${name}: no conformance probe implementation`).not.toContain(
      'conformance.notAMethod',
    );
  }
  // Rejection of prod / unset / unknown APP_ENV is covered by F1-01c entries.test.ts.
  // Only APP_ENV=test artifacts are provided here; never start a second build in a test.
});
