// Vitest globalSetup of the build smoke (F1-01k; test/vitest.build-smoke.config.ts, `test:smoke`).
//
// Builds the production artifacts the way the release does (规划/03 §8.2) and serves each one on
// the loopback for the rule tests in test/spec/**/*.smoke.test.ts:
//   - apps/h5: `vite build --mode app | landing | conformance` with APP_ENV=test (conformance
//     builds only outside production);
//   - apps/admin: `vite build` (`build:web`) with NODE_ENV=production.
// Every build runs in a child process (the Vite CLI of the app's own dependency) and writes to a
// fresh directory under os.tmpdir() (a tmpfs in the verify container), never into the repository.
// Each entry gets its own read-only static server on 127.0.0.1, port 0: GET and HEAD only, no path
// outside the build directory, an extensionless unknown path falls back to the entry's
// index.html (client-side routes such as /rules), a missing file with an extension is a 404.
// The servers must answer GET / with 200 before any test runs.
//
// Any failure here (a build, a server, the health check) throws: that is infrastructure, never a
// valid red (规划/11 §2.3 step 3; tools/guard/lib/red-check.ts). The thrown message carries the
// build output. Teardown closes the servers and removes the temporary directory.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, get, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

import type { BuildSmokeEntries } from './types.ts';

type EntryName = keyof BuildSmokeEntries;

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** How long one `vite build` may take (four run side by side). */
const BUILD_TIMEOUT_MS = 300_000;
/** Most build output kept for the error message. */
const OUTPUT_TAIL = 16_000;

type Build = {
  name: EntryName;
  /** Package directory (the Vite config and the Vite dependency live there). */
  cwd: string;
  args: string[];
  env: Record<string, string>;
};

const BUILDS: Build[] = [
  ...(['app', 'landing', 'conformance'] as const).map((name): Build => ({
    name,
    cwd: join(REPO_ROOT, 'apps/h5'),
    args: ['--mode', name],
    env: { APP_ENV: 'test' },
  })),
  // The admin config does not pin NODE_ENV itself: a build under Vitest's NODE_ENV=test would
  // ship the development JSX runtime (jsxDEV).
  { name: 'admin', cwd: join(REPO_ROOT, 'apps/admin'), args: [], env: { NODE_ENV: 'production' } },
];

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

/** The Vite CLI of the package in `cwd` (its own pinned dependency). */
function viteCli(cwd: string): string {
  const require = createRequire(join(cwd, 'package.json'));
  const pkgFile = require.resolve('vite/package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['vite'];
  if (bin === undefined) throw new Error(`build smoke: ${pkgFile} names no vite binary`);
  return join(pkgFile, '..', bin);
}

/** The parent's environment without Vitest's markers, plus `extra`. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'VITEST' || key.startsWith('VITEST_') || key === 'TEST') continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

function tail(text: string): string {
  return text.length <= OUTPUT_TAIL ? text : `…${text.slice(-OUTPUT_TAIL)}`;
}

/** Runs one `vite build` into `outDir`; rejects with the build output when it fails. */
function runBuild(build: Build, outDir: string): Promise<void> {
  const args = [
    viteCli(build.cwd),
    'build',
    ...build.args,
    '--outDir',
    outDir,
    '--emptyOutDir',
    '--logLevel',
    'warn',
  ];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: build.cwd,
      env: childEnv(build.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, BUILD_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`build smoke: cannot start the ${build.name} build: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const index = join(outDir, 'index.html');
      if (code === 0 && existsSync(index)) {
        resolvePromise();
        return;
      }
      const why =
        code === 0
          ? `wrote no ${index}`
          : signal !== null
            ? `was killed (${signal}; limit ${String(BUILD_TIMEOUT_MS)} ms)`
            : `exited ${String(code)}`;
      reject(
        new Error(
          `build smoke: the ${build.name} build (vite build ${build.args.join(' ')} in ` +
            `${relative(REPO_ROOT, build.cwd)}) ${why}\n${tail(output)}`,
        ),
      );
    });
  });
}

/** The file below `root` that `pathname` names, or null when it leaves `root`. */
function within(root: string, pathname: string): string | null {
  if (pathname.includes('\0')) return null;
  const file = resolve(root, `.${pathname}`);
  const rel = relative(root, file);
  if (rel === '') return root;
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return file;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A read-only static server for one build directory, listening on 127.0.0.1 (port 0). */
async function serve(distDir: string): Promise<{ server: Server; url: string }> {
  const root = resolve(distDir);
  const index = join(root, 'index.html');
  const server = createServer((req, res) => {
    const send = (
      status: number,
      file: string | null,
      type = 'text/plain; charset=utf-8',
    ): void => {
      const body = file === null ? Buffer.from(`${String(status)}\n`) : readFileSync(file);
      res.writeHead(status, {
        'Content-Type': type,
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      send(405, null);
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      send(400, null);
      return;
    }
    const file = within(root, pathname);
    if (file === null) {
      send(403, null);
      return;
    }
    if (isFile(file)) {
      send(200, file, CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
      return;
    }
    // Single-page fallback for client routes; a missing asset stays a 404.
    if (extname(pathname) === '') {
      send(200, index, CONTENT_TYPES['.html']);
      return;
    }
    send(404, null);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${String(port)}/` };
}

/** GET `url`: rejects unless it answers 200 within 5 s. */
function healthCheck(name: EntryName, url: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const req = get(url, { timeout: 5_000 }, (res) => {
      res.resume();
      if (res.statusCode === 200) resolvePromise();
      else
        reject(
          new Error(`build smoke: health check of ${name} (${url}) got ${String(res.statusCode)}`),
        );
    });
    req.on('timeout', () => req.destroy(new Error('no answer within 5 s')));
    req.on('error', (error) => {
      reject(new Error(`build smoke: health check of ${name} (${url}) failed: ${error.message}`));
    });
  });
}

function closeAll(servers: Server[]): Promise<void> {
  return Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolvePromise) => {
          server.closeAllConnections();
          server.close(() => resolvePromise());
        }),
    ),
  ).then(() => undefined);
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const tmp = mkdtempSync(join(tmpdir(), 'couli-build-smoke-'));
  const servers: Server[] = [];
  const teardown = async (): Promise<void> => {
    await closeAll(servers);
    rmSync(tmp, { recursive: true, force: true });
  };
  try {
    const dirs = Object.fromEntries(BUILDS.map((b) => [b.name, join(tmp, b.name)])) as Record<
      EntryName,
      string
    >;
    const results = await Promise.allSettled(BUILDS.map((b) => runBuild(b, dirs[b.name])));
    const failed = results.flatMap((r) =>
      r.status === 'rejected'
        ? [r.reason instanceof Error ? r.reason.message : String(r.reason)]
        : [],
    );
    if (failed.length > 0) throw new Error(failed.join('\n\n'));

    const entries = {} as BuildSmokeEntries;
    for (const build of BUILDS) {
      const { server, url } = await serve(dirs[build.name]);
      servers.push(server);
      await healthCheck(build.name, url);
      entries[build.name] = { url, distDir: dirs[build.name] };
    }
    project.provide('buildSmoke', { entries });
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
