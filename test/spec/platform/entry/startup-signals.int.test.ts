// B1-01zl: real built api / stream / admin / payout processes.
// An IPC gate in the probe delays the real Nest factory for the before-init cases; it never
// supplies an app or a signal handler. The queue-start cases below use no factory gate.
// Hold pgboss.version just as the B1-01t worker tests do: init has finished, queue.start()
// is waiting, and HTTP listen has not happened. Observe the lock waiter before signalling.
// Both repeated signals are sent before releasing the lock; an IPC checkpoint separates
// their deliveries. Neither the probe nor the parent supplies a child signal handler.
// Each case combines unchanged behaviour with a startup-signal assertion, so every case
// is red on the old entry implementation (default signal termination, not a timeout).
// Database provisioning goes through the integration global setup of @couli/db/testing.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const API = path.join(ROOT, 'apps/api');
const PROBE = pathToFileURL(path.join(ROOT, 'test/spec/platform/entry/lifecycle-probe.ts')).href;
const ENTRIES = ['api', 'stream', 'admin', 'payout'] as const;
type Entry = (typeof ENTRIES)[number];
type Log = Record<string, unknown>;
type End = { code: number | null; signal: NodeJS.Signals | null };

let database: TestDatabase;
let observer: Kysely<DB>;
let locker: Kysely<DB>;

beforeAll(async () => {
  const tsc = createRequire(path.join(ROOT, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-b', API], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (built.error) throw built.error;
  if (built.status !== 0) throw new Error(`Entry build failed: ${built.stdout}${built.stderr}`);
  database = await createTestDatabase();
  observer = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
  locker = createDb({ connectionString: database.urlFor('couli_app'), max: 1 });
}, 180_000);

afterAll(async () => {
  await Promise.all([observer, locker].filter(Boolean).map((db) => destroyDb(db)));
  await database?.drop();
}, 60_000);

async function poll(predicate: () => boolean | Promise<boolean>, limit = 10_000): Promise<boolean> {
  const deadline = performance.now() + limit;
  do {
    if (await predicate()) return true;
    await delay(20);
  } while (performance.now() < deadline);
  return false;
}

function logs(stdout: string): Log[] {
  // Ignore a partial final line while polling, but let malformed complete JSON fail loudly.
  return stdout
    .split('\n')
    .slice(0, -1)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Log);
}

function lifecycle(records: Log[]): string[] {
  return records
    .map((record) => String(record.msg))
    .filter((msg) =>
      [
        'started',
        'stopping',
        'stopped',
        'startup_failed',
        'shutdown_failed',
        'config_invalid',
      ].includes(msg),
    );
}

interface Running {
  child: ChildProcess;
  records(): Log[];
  stderr(): string;
  ended(): boolean;
  closed: Promise<End>;
  checkpoint(): Promise<boolean>;
  factoryWaiting(): boolean;
  releaseFactory(): void;
  queueWorking(): Promise<boolean>;
}

function launch(entry: Entry, port: number, exitAfterInit = false, holdFactory = false): Running {
  const env: Record<string, string> = {
    APP_ENV: 'test',
    LOG_LEVEL: 'info',
    API_HOST: '127.0.0.1',
    API_PORT: String(port),
    STREAM_PORT: String(port),
    ADMIN_PORT: String(port),
    DATABASE_URL: database.urlFor(entry === 'payout' ? 'couli_payout' : 'couli_app'),
    ...(entry === 'admin' ? { DATABASE_READ_URL: database.urlFor('couli_readonly') } : {}),
    COULI_EXIT_AFTER_INIT: exitAfterInit ? '1' : '0',
    ENTRY_PROBE_HOLD_FACTORY: holdFactory ? '1' : '0',
    ENTRY_PROBE_QUEUE: entry === 'payout' && !exitAfterInit && !holdFactory ? '1' : '0',
    ...(entry === 'payout' ? {} : { REDIS_URL: 'redis://127.0.0.1:1/0' }),
  };
  for (const name of ['PATH', 'HOME', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const child = spawn(
    process.execPath,
    ['--import', PROBE, path.join(API, `dist/main.${entry}.js`)],
    {
      cwd: API,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let stdout = '';
  let stderr = '';
  let ended = false;
  let sequence = 0;
  const replies = new Set<unknown>();
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('message', (message: unknown) => {
    replies.add(message);
  });
  child.on('exit', () => {
    ended = true;
  });
  const closed = new Promise<End>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    records: () => logs(stdout),
    stderr: () => stderr,
    ended: () => ended,
    closed,
    factoryWaiting: () => replies.has('factory-waiting'),
    releaseFactory() {
      if (!ended && child.connected) child.send('release-factory', () => undefined);
    },
    async queueWorking() {
      if (ended || !child.connected) return false;
      child.send('queue-check', () => undefined);
      await poll(() => ended || replies.has('queue-working') || replies.has('queue-failed'));
      return !ended && replies.has('queue-working');
    },
    async checkpoint() {
      if (ended || !child.connected) return false;
      const id = ++sequence;
      child.send(id, () => undefined);
      await poll(() => replies.has(id) || ended);
      return replies.has(id) && !ended;
    },
  };
}

async function dispose(run: Running): Promise<void> {
  if (!run.ended()) run.child.kill('SIGKILL');
  await run.closed;
}

async function finish(run: Running): Promise<End & { natural: boolean }> {
  // A leaked timer/pool gets a bounded, diagnostic assertion failure, not a Vitest timeout.
  if (!(await poll(run.ended, 10_000))) run.child.kill('SIGKILL');
  const end = await run.closed;
  const report = run
    .stderr()
    .match(/^entry-probe: beforeExit (\d+)\nentry-probe: signals \d+ \d+\n$/);
  return { ...end, natural: report !== null && Number(report[1]) === end.code };
}

/** Reserve an ephemeral port, or prove the entry's former port can be rebound. */
async function bindAndClose(port = 0): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing TCP address');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function portFree(port: number): Promise<boolean> {
  try {
    return (await bindAndClose(port)) === port;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return false;
    throw error;
  }
}

async function queueWaiting(entry: Entry): Promise<boolean> {
  const result = await sql<{ waiting: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE a.datname = current_database() AND a.application_name = ${`couli-${entry}`}
        AND l.relation = 'pgboss.version'::regclass AND NOT l.granted
    ) AS waiting
  `.execute(observer);
  return result.rows[0]?.waiting === true;
}

async function sessions(entry: Entry): Promise<number> {
  const names = entry === 'admin' ? ['couli-admin', 'couli-admin-read'] : [`couli-${entry}`];
  const result = await sql<{ n: string }>`
    SELECT count(*)::text AS n FROM pg_stat_activity
    WHERE datname = current_database() AND application_name IN (${sql.join(names)})
  `.execute(observer);
  return Number(result.rows[0]?.n);
}

async function holdQueue(failStartup: boolean) {
  let release = () => undefined as void;
  let locked = () => undefined as void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = locker.transaction().execute(async (trx) => {
    await sql`LOCK TABLE pgboss.version IN ACCESS EXCLUSIVE MODE`.execute(trx);
    locked();
    await barrier;
    if (failStartup) await sql`UPDATE pgboss.version SET version = 41`.execute(trx);
  });
  await Promise.race([acquired, done]);
  return { release, done };
}

async function duringStartup(entry: Entry, signal: 'SIGTERM' | 'SIGINT', failStartup = false) {
  const port = await bindAndClose();
  const holder = await holdQueue(failStartup);
  const run = launch(entry, port);
  try {
    await poll(async () => run.ended() || (await queueWaiting(entry)));
    // This is a setup assertion: do not send a signal until the actual queue wait is visible.
    expect({
      ended: run.ended(),
      waiting: await queueWaiting(entry),
      lifecycle: lifecycle(run.records()),
    }).toEqual({ ended: false, waiting: true, lifecycle: [] });
    run.child.kill(signal);
    await poll(() => run.ended() || lifecycle(run.records()).includes('stopping'));
    // Send the SAME signal again only after the first stopping was delivered. A once-handler
    // would be killed here; a handler that closes immediately loses the database lock waiter.
    const firstResponsive = await run.checkpoint();
    if (!run.ended()) run.child.kill(signal);
    const secondResponsive = await run.checkpoint();
    const blocked = {
      firstResponsive,
      secondResponsive,
      waiting: await queueWaiting(entry),
      messages: lifecycle(run.records()),
    };
    holder.release();
    await holder.done;
    const end = await finish(run);
    await poll(async () => (await sessions(entry)) === 0);
    const records = run.records();
    return {
      blocked,
      end,
      messages: lifecycle(records),
      stopping: records
        .filter((record) => record.msg === 'stopping')
        .map((record) => ({
          level: record.level,
          entry: record.entry,
          signal: record.signal,
        })),
      sessionsLeft: await sessions(entry),
      portFree: await portFree(port),
      // Task ledger: failure must detach startup signal handlers (no later extra stopping).
      ...(failStartup
        ? {
            handlersAtExit: run
              .stderr()
              .match(/entry-probe: signals (\d+) (\d+)/)
              ?.slice(1)
              .map(Number),
          }
        : {}),
    };
  } finally {
    holder.release();
    await holder.done;
    await dispose(run);
    if (failStartup) await sql`UPDATE pgboss.version SET version = 42`.execute(locker);
  }
}

async function normalStartup(entry: Entry, signal: 'SIGTERM' | 'SIGINT') {
  const port = await bindAndClose();
  const run = launch(entry, port);
  try {
    await poll(() => run.ended() || lifecycle(run.records()).includes('started'));
    // Keep polling for premature exit past pg's default 10 s idle timeout. Checkpoints do not
    // touch the database or keep the child's IPC channel referenced. No fixed sleep verdict.
    const began = performance.now();
    let survivedIdleWindow = true;
    do {
      if (!(await run.checkpoint())) {
        survivedIdleWindow = false;
        break;
      }
      await poll(run.ended, 250);
    } while (!run.ended() && performance.now() - began < 16_000);
    survivedIdleWindow &&= !run.ended() && performance.now() - began >= 16_000;
    const responsive = await run.checkpoint();
    const beforeSignal = lifecycle(run.records());
    const listening = !(await portFree(port));
    const serving = entry === 'payout' ? await run.queueWorking() : await healthy(entry, port);
    run.child.kill(signal);
    const end = await finish(run);
    return {
      responsive,
      survivedIdleWindow,
      serving,
      beforeSignal,
      listening,
      end,
      messages: lifecycle(run.records()),
      portFree: await portFree(port),
    };
  } finally {
    await dispose(run);
  }
}

async function healthy(entry: Entry, port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    const body = (await response.json()) as { data?: { status?: string; entry?: string } };
    return response.ok && body.data?.status === 'ok' && body.data.entry === entry;
  } catch {
    return false;
  }
}

async function beforeInit(entry: Entry, signal: 'SIGTERM' | 'SIGINT') {
  const port = await bindAndClose();
  const run = launch(entry, port, false, true);
  try {
    await poll(() => run.ended() || run.factoryWaiting());
    expect({
      waiting: run.factoryWaiting(),
      ended: run.ended(),
      messages: lifecycle(run.records()),
    }).toEqual({ waiting: true, ended: false, messages: [] });
    run.child.kill(signal);
    await poll(() => run.ended() || lifecycle(run.records()).includes('stopping'));
    const firstResponsive = await run.checkpoint();
    if (!run.ended()) run.child.kill(signal);
    const secondResponsive = await run.checkpoint();
    const blocked = {
      firstResponsive,
      secondResponsive,
      messages: lifecycle(run.records()),
      portFree: await portFree(port),
    };
    run.releaseFactory();
    const end = await finish(run);
    await poll(async () => (await sessions(entry)) === 0);
    return {
      blocked,
      end,
      messages: lifecycle(run.records()),
      sessionsLeft: await sessions(entry),
      portFree: await portFree(port),
    };
  } finally {
    run.releaseFactory();
    await dispose(run);
  }
}

async function exitAfterInit(entry: Entry) {
  const port = await bindAndClose();
  // If exitAfterInit accidentally starts the queue, it cannot finish while this lock is held.
  const holder = await holdQueue(false);
  const run = launch(entry, port, true);
  try {
    const end = await finish(run);
    return {
      end,
      messages: lifecycle(run.records()),
      listening: run
        .records()
        .filter((record) => record.msg === 'started')
        .map((record) => record.listening),
      portFree: await portFree(port),
    };
  } finally {
    holder.release();
    await holder.done;
    await dispose(run);
  }
}

for (const entry of ENTRIES) {
  for (const [index, signal] of (['SIGTERM', 'SIGINT'] as const).entries()) {
    it(`[AC-B1-01zl#${index + 1}] ${entry}: 启动中两次 ${signal} 等队列启动结束后只收尾一次；正常启动与 exitAfterInit 不退化`, async () => {
      const normal = await normalStartup(entry, signal);
      const initOnly = await exitAfterInit(entry);
      const interrupted = await duringStartup(entry, signal);
      expect({ normal, initOnly, interrupted }).toEqual({
        normal: {
          responsive: true,
          survivedIdleWindow: true,
          serving: true,
          beforeSignal: ['started'],
          listening: entry !== 'payout',
          end: { code: 0, signal: null, natural: true },
          messages: ['started', 'stopping', 'stopped'],
          portFree: true,
        },
        initOnly: {
          end: { code: 0, signal: null, natural: true },
          messages: ['started'],
          listening: [false],
          portFree: true,
        },
        interrupted: {
          blocked: {
            firstResponsive: true,
            secondResponsive: true,
            waiting: true,
            messages: ['stopping'],
          },
          end: { code: 0, signal: null, natural: true },
          messages: ['stopping', 'stopped'],
          stopping: [{ level: 30, entry, signal }],
          sessionsLeft: 0,
          portFree: true,
        },
      });
    }, 60_000);
  }
}

for (const entry of ENTRIES) {
  for (const [index, signal] of (['SIGTERM', 'SIGINT'] as const).entries()) {
    it(`[AC-B1-01zl#${index + 4}] ${entry}: 应用/context 创建完成之前收到两次 ${signal}，等待创建完成后只收尾一次`, async () => {
      expect(await beforeInit(entry, signal)).toEqual({
        blocked: {
          firstResponsive: true,
          secondResponsive: true,
          messages: ['stopping'],
          portFree: true,
        },
        end: { code: 0, signal: null, natural: true },
        messages: ['stopping', 'stopped'],
        sessionsLeft: 0,
        portFree: true,
      });
    }, 60_000);
  }
}

for (const entry of ['api', 'payout'] as const) {
  it(`[AC-B1-01zl#3] ${entry}: 启动中收到 SIGTERM 后队列启动失败仍关闭资源并自然退出 1`, async () => {
    const seen = await duringStartup(entry, 'SIGTERM', true);
    expect(seen).toMatchObject({
      blocked: {
        firstResponsive: true,
        secondResponsive: true,
        waiting: true,
        messages: ['stopping'],
      },
      end: { code: 1, signal: null, natural: true },
      stopping: [{ level: 30, entry, signal: 'SIGTERM' }],
      sessionsLeft: 0,
      portFree: true,
      handlersAtExit: [0, 0],
    });
    expect(seen.messages).toContain('startup_failed');
    expect(seen.messages).not.toContain('started');
  }, 60_000);
}
