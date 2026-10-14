// B1-01zs: real worker entry regressions; no production exports or mocks are needed.
// 1/2. A wrong pg-boss version makes queue.start fail. As in worker-signal-start-more,
// a TCP relay withholds PostgreSQL's FIN: observing it proves resource cleanup has begun.
// Send the first SIGTERM / SIGINT at that event, keep withholding FIN until the worker ends,
// and require startup_failed + exit 1 with no stopping/stopped/shutdown_failed/started.
// This follows the task's explicit failed-exit requirement, including signals during cleanup.
// 3/4. Keep ACCESS EXCLUSIVE on pgboss.version until AFTER the worker closes, with and without
// SIGTERM during the observed lock wait. Startup must fail and end within a generous 60 s.
// The implementation chooses its own timeout; these tests prescribe no exact millisecond value.
// B1-01t contract 7 d remains: a signal received before failure keeps its one stopping line.
// The watchdog only cleans up a regression: forced SIGKILL is an assertion failure, never success
// or a Vitest timeout. Parse stdout only after 'close', when the pipes have drained.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { gate, waitFor } from './kit.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const API_DIR = path.join(ROOT, 'apps/api');
const PROBE = pathToFileURL(path.join(HERE, 'exit-probe.ts')).href;
const END_LIMIT_MS = 60_000;
const LIFECYCLE = ['started', 'stopping', 'stopped', 'startup_failed', 'shutdown_failed'];

let database: TestDatabase;
let observer: Kysely<DB>;
let holderDb: Kysely<DB>;

beforeAll(async () => {
  const tsc = createRequire(path.join(ROOT, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-b', API_DIR], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (built.error !== undefined) throw built.error;
  if (built.status !== 0) throw new Error(`worker build failed: ${built.stdout}${built.stderr}`);
  database = await createTestDatabase();
  observer = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  holderDb = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
}, 180_000);

afterAll(async () => {
  await Promise.all([observer, holderDb].filter(Boolean).map((db) => destroyDb(db)));
  await database?.drop();
}, 30_000);

interface End {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly forced: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

interface Worker {
  readonly child: ChildProcess;
  readonly closed: Promise<End>;
  exited(): boolean;
}

function launch(appUrl: string): Worker {
  const env: Record<string, string> = {
    APP_ENV: 'test',
    LOG_LEVEL: 'info',
    CLOCK_NOW: '2026-11-20T03:04:05Z',
    DATABASE_URL: appUrl,
    DATABASE_MAINT_URL: database.urlFor('couli_maint'),
    REDIS_URL: 'redis://127.0.0.1:1/0',
  };
  for (const name of ['PATH', 'HOME', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const child = spawn(
    process.execPath,
    ['--import', PROBE, path.join(API_DIR, 'dist/main.worker.js')],
    { cwd: API_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  let exited = false;
  let forced = false;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.once('exit', () => {
    exited = true;
  });
  const timer = setTimeout(() => {
    forced = true;
    child.kill('SIGKILL');
  }, END_LIMIT_MS);
  const closed = new Promise<End>((resolve, reject) => {
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, forced, stdout, stderr });
    });
  });
  return { child, closed, exited: () => exited };
}

function records(end: End): Record<string, unknown>[] {
  return end.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function outcome(end: End) {
  const lines = records(end);
  return {
    code: end.code,
    signal: end.signal,
    forced: end.forced,
    lifecycle: lines.map((line) => line.msg).filter((msg) => LIFECYCLE.includes(String(msg))),
    configInvalid: lines.some((line) => line.msg === 'config_invalid'),
    maintenanceStarted: lines.some((line) => String(line.msg).startsWith('partition_')),
    stderr: end.stderr,
  };
}

function failedOutcome(priorSignal: boolean) {
  return {
    code: 1,
    signal: null,
    forced: false,
    lifecycle: priorSignal ? ['stopping', 'startup_failed'] : ['startup_failed'],
    configInvalid: false,
    maintenanceStarted: false,
    stderr: 'exit-probe: beforeExit 1\n',
  };
}

interface Relay {
  readonly url: string;
  close(): Promise<void>;
}

// Forward bytes unchanged. Holding only the server FIN leaves the worker inside its real
// handle.close(), whose existing close bound must still complete after the signal.
async function holdCleanup(url: string, onCleanup: () => void): Promise<Relay> {
  const target = new URL(url);
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    const upstream = net.connect({
      host: target.hostname,
      port: Number(target.port || '5432'),
      allowHalfOpen: true,
    });
    sockets.add(client);
    sockets.add(upstream);
    client.on('data', (chunk) => upstream.write(chunk));
    client.on('end', () => upstream.end());
    upstream.on('data', (chunk) => client.write(chunk));
    upstream.once('end', onCleanup);
    const destroy = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', destroy);
    upstream.on('error', destroy);
    client.on('close', () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => sockets.delete(upstream));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('relay has no TCP address');
  const through = new URL(url);
  through.hostname = '127.0.0.1';
  through.port = String(address.port);
  return {
    url: through.href,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

it.each([
  { ac: '1', signal: 'SIGTERM' as const },
  { ac: '2', signal: 'SIGINT' as const },
])(
  '[AC-B1-01zs#$ac] 启动失败收尾期间收到 $signal：只记 startup_failed，以 1 自然退出',
  async ({ signal }) => {
    await sql`UPDATE pgboss.version SET version = 41`.execute(observer);
    let worker: Worker | undefined;
    let cleanupReached = false;
    let signalSent = false;
    const relay = await holdCleanup(database.urlFor('couli_app'), () => {
      // Send at the observed cleanup boundary, without a fixed sleep or a polling race against
      // the handle's close timer. Only the first FIN sends a signal.
      if (cleanupReached) return;
      cleanupReached = true;
      signalSent = worker?.child.kill(signal) ?? false;
    });
    try {
      worker = launch(relay.url);
      const end = await worker.closed;
      expect({ cleanupReached, signalSent, ...outcome(end) }).toEqual({
        cleanupReached: true,
        signalSent: true,
        ...failedOutcome(false),
      });
      expect(records(end).find((line) => line.msg === 'startup_failed')).toMatchObject({
        err: { code: 'schema_mismatch' },
      });
    } finally {
      worker?.child.kill('SIGKILL');
      await worker?.closed;
      await relay.close();
      await sql`UPDATE pgboss.version SET version = 42`.execute(observer);
    }
  },
  120_000,
);

async function holdVersion(): Promise<{ release(): void; done: Promise<void> }> {
  const locked = gate();
  const release = gate();
  const done = holderDb.transaction().execute(async (trx) => {
    await sql`LOCK TABLE pgboss.version IN ACCESS EXCLUSIVE MODE`.execute(trx);
    locked.open();
    await release.wait();
  });
  // A failed LOCK must reject the setup, rather than masquerade as an application regression.
  await Promise.race([locked.wait(), done]);
  return { release: () => release.open(), done };
}

async function waitingForVersion(): Promise<boolean> {
  const result = await sql<{ waiting: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE a.datname = current_database() AND a.application_name = 'couli-worker'
        AND l.locktype = 'relation' AND l.relation = 'pgboss.version'::regclass
        AND NOT l.granted AND a.wait_event_type = 'Lock'
    ) AS waiting
  `.execute(observer);
  return result.rows[0]?.waiting === true;
}

it.each([
  { ac: '3', signal: null, label: '不发信号' },
  { ac: '4', signal: 'SIGTERM' as const, label: '锁等待期间发 SIGTERM' },
])(
  '[AC-B1-01zs#$ac] 版本表一直被锁，$label：有界启动失败、退出码 1，不能靠释放锁退出',
  async ({ signal }) => {
    const holder = await holdVersion();
    const worker = launch(database.urlFor('couli_app'));
    try {
      let waiting = false;
      await waitFor(async () => {
        waiting = await waitingForVersion();
        return waiting || worker.exited();
      }, 45_000);
      expect(waiting, '必须先观察到真实 worker 在版本表上等待锁').toBe(true);
      if (signal !== null) expect(worker.child.kill(signal)).toBe(true);
      // Do not release the lock to rescue startup: a hung main implementation reaches SIGKILL
      // and fails the following outcome assertion well before this test's own timeout.
      const end = await worker.closed;
      expect(outcome(end)).toEqual(failedOutcome(signal !== null));
      if (signal !== null) {
        expect(records(end).filter((line) => line.msg === 'stopping')).toMatchObject([
          { level: 30, entry: 'worker', signal },
        ]);
      }
    } finally {
      worker.child.kill('SIGKILL');
      await worker.closed;
      holder.release();
      await holder.done;
    }
  },
  120_000,
);
