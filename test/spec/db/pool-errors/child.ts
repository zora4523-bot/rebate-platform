// Real PostgreSQL scenarios for B1-01zp §9. Run only by the integration test, in a plain
// Node process: deliberately no uncaughtException / unhandledRejection / error handlers
// on the default pool or its clients. Import this file for types only.
import { createRequire } from 'node:module';
import type { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export type Scenario = 'active' | 'idle' | 'borrowed';
export interface Request {
  readonly scenario: Scenario;
  readonly url: string;
  readonly applicationName: string;
}

const LIMIT_MS = 8000;
const MAX = 2;
const BIG = 9007199254740993n;
const REPORT_PREFIX = 'B1-01zp-result:';

async function bounded<T>(promise: Promise<T>, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout: ${step}`)), LIMIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface Session {
  pid: number;
  state: string;
  query: string;
  wait_event: string | null;
}

async function sessions(observer: Kysely<DB>, name: string): Promise<Session[]> {
  const result = await sql<Session>`
    SELECT pid, state, query, wait_event FROM pg_stat_activity
    WHERE datname = current_database() AND application_name = ${name}
  `.execute(observer);
  return result.rows;
}

async function waitFor<T>(read: () => Promise<T | undefined>, step: string): Promise<T> {
  return bounded(
    (async () => {
      const deadline = performance.now() + LIMIT_MS;
      while (performance.now() < deadline) {
        const value = await read();
        if (value !== undefined) return value;
        await delay(20);
      }
      throw new Error(`timeout: ${step}`);
    })(),
    step,
  );
}

async function terminate(observer: Kysely<DB>, pid: number): Promise<boolean> {
  const result = await sql<{ terminated: boolean }>`
    SELECT pg_terminate_backend(${pid}) AS terminated
  `.execute(observer);
  return result.rows[0]?.terminated === true;
}

async function gone(observer: Kysely<DB>, name: string, pid: number): Promise<boolean> {
  return waitFor(async () => {
    const rows = await sessions(observer, name);
    return rows.every((row) => row.pid !== pid) ? true : undefined;
  }, 'terminated backend disappears');
}

async function bigIntWorks(db: Kysely<DB>): Promise<boolean> {
  const result = await sql<{ value: unknown }>`SELECT 9007199254740993::int8 AS value`.execute(db);
  return result.rows[0]?.value === BIG;
}

// Resolve the already installed driver from its owning package; test/package.json does
// not depend directly on pg. The structural type comes from the public createDb API.
type Factory = NonNullable<Parameters<typeof createDb>[0]['poolFactory']>;
type FactoryPool = ReturnType<Factory> & EventEmitter;
const requireDb = createRequire(new URL('../../../../packages/db/package.json', import.meta.url));
const { Pool } = requireDb('pg') as {
  Pool: new (config: Parameters<Factory>[0]) => FactoryPool;
};

async function factoryFacts(url: string, name: string, preexisting: boolean) {
  let pool: FactoryPool | undefined;
  let before = -1;
  const ownedListener = (): void => {};
  const db = createDb({
    connectionString: url,
    applicationName: `${name}-factory`,
    max: MAX,
    poolFactory(config) {
      pool = new Pool(config);
      if (preexisting) pool.on('error', ownedListener);
      before = pool.listenerCount('error');
      return pool;
    },
  });
  const afterCreate = pool?.listenerCount('error');
  try {
    const bigint = await bounded(bigIntWorks(db), 'factory int8 query');
    return {
      before,
      afterCreate,
      afterQuery: pool?.listenerCount('error'),
      originalListenerPreserved: !preexisting || pool?.listeners('error').includes(ownedListener),
      bigint,
    };
  } finally {
    await bounded(destroyDb(db), 'factory destroyDb');
  }
}

async function recover(db: Kysely<DB>, observer: Kysely<DB>, name: string, deadPid: number) {
  const next = await bounded(
    sql<{ value: number; pid: number }>`SELECT 1 AS value, pg_backend_pid() AS pid`.execute(db),
    'next query on the same instance',
  );
  // Hold both leases at a barrier so success cannot come from one working pool slot.
  let arrived = 0;
  let open = (): void => {};
  const barrier = new Promise<void>((resolve) => {
    open = resolve;
  });
  const results = await bounded(
    Promise.all(
      Array.from({ length: MAX }, () =>
        db.connection().execute(async (connection) => {
          const result = await sql<{ value: number; pid: number }>`
            SELECT 1 AS value, pg_backend_pid() AS pid
          `.execute(connection);
          arrived += 1;
          if (arrived === MAX) open();
          await bounded(barrier, 'both recovered pool slots are usable');
          return result.rows[0];
        }),
      ),
    ),
    'concurrent recovery queries',
  );
  const live = await sessions(observer, name);
  return {
    nextSucceeded: next.rows[0]?.value === 1,
    nextUsesLiveBackend: next.rows[0]?.pid !== deadPid,
    concurrentValues: results.map((row) => row?.value),
    distinctBackends: new Set(results.map((row) => row?.pid)).size,
    deadBackendReused: results.some((row) => row?.pid === deadPid),
    withinMax: live.length > 0 && live.length <= MAX,
    deadBackendPresent: live.some((row) => row.pid === deadPid),
    bigint: await bigIntWorks(db),
  };
}

async function run(request: Request) {
  const { url, applicationName: name, scenario } = request;
  const db = createDb({ connectionString: url, max: MAX, applicationName: name });
  const observer = createDb({
    connectionString: url,
    max: 1,
    applicationName: `${name}-observer`,
  });
  let destroyed = false;
  try {
    const factories = [await factoryFacts(url, name, false), await factoryFacts(url, name, true)];
    const bigintBefore = await bounded(bigIntWorks(db), 'default int8 query');
    let deadPid = -1;
    let terminated = false;
    let backendGone = false;
    let victimRejected = false;
    let otherQueryUnaffected = false;

    if (scenario === 'active') {
      // Keep the second query active with an advisory lock, rather than assuming a
      // fixed sleep is long enough on a busy test server. Only the observer owns it.
      await sql`SELECT pg_advisory_lock(101014)`.execute(observer);
      const healthy = sql<{ answer: number; pid: number }>`
        SELECT 42 AS answer, pg_backend_pid() AS pid, pg_advisory_xact_lock(101014)
      `
        .execute(db)
        .then(
          (result) => result.rows[0],
          () => undefined,
        );
      const healthySession = await waitFor(async () => {
        return (await sessions(observer, name)).find((row) => row.wait_event === 'advisory');
      }, 'healthy query waiting for observer lock');
      const victim = db.connection().execute(async (connection) => {
        const rejected = await sql`SELECT pg_sleep(30) /* B1-01zp-victim */`
          .execute(connection)
          .then(
            () => false,
            (error: unknown) => error instanceof Error,
          );
        // Keep the failed client borrowed until its socket's error/end events arrive.
        // Otherwise pg-pool may have reattached its idle listener before the error.
        await gone(observer, name, deadPid);
        await delay(200);
        return rejected;
      });
      // Attach a rejection handler immediately, including to connection acquisition.
      const victimOutcome = victim.then(
        (rejected) => rejected,
        () => false,
      );
      const victimSession = await waitFor(async () => {
        return (await sessions(observer, name)).find(
          (row) => row.state === 'active' && row.query.includes('B1-01zp-victim'),
        );
      }, 'victim query running');
      deadPid = victimSession.pid;
      terminated = await terminate(observer, deadPid);
      backendGone = await gone(observer, name, deadPid);
      victimRejected = await bounded(victimOutcome, 'interrupted query rejects');
      const stillRunning = (await sessions(observer, name)).some(
        (row) => row.pid === healthySession.pid && row.wait_event === 'advisory',
      );
      await sql`SELECT pg_advisory_unlock(101014)`.execute(observer);
      const healthyRow = await bounded(healthy, 'unaffected query finishes');
      otherQueryUnaffected =
        stillRunning && healthyRow?.answer === 42 && healthyRow.pid === healthySession.pid;
    } else if (scenario === 'idle') {
      const idle = await waitFor(async () => {
        return (await sessions(observer, name)).find((row) => row.state === 'idle');
      }, 'default connection is idle');
      deadPid = idle.pid;
      terminated = await terminate(observer, deadPid);
      backendGone = await gone(observer, name, deadPid);
      // Server disappearance precedes local socket delivery; allow it to be processed
      // while the connection is still idle (and no query could catch the failure).
      await delay(200);
    } else {
      victimRejected = await bounded(
        db.connection().execute(async (connection) => {
          const result = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(
            connection,
          );
          deadPid = result.rows[0]?.pid ?? -1;
          terminated = await terminate(observer, deadPid);
          backendGone = await gone(observer, name, deadPid);
          // Still inside connection().execute: pg-pool's idle listener is absent.
          await delay(200);
          return sql`SELECT 1`.execute(connection).then(
            () => false,
            (error: unknown) => error instanceof Error,
          );
        }),
        'query on terminated borrowed connection rejects',
      );
    }

    const recovery = await recover(db, observer, name, deadPid);
    await bounded(destroyDb(db), 'destroyDb after disconnection');
    destroyed = true;
    const closedSessionsGone = await waitFor(async () => {
      return (await sessions(observer, name)).length === 0 ? true : undefined;
    }, 'destroyDb closes remaining sessions');
    return {
      scenario,
      factories,
      bigintBefore,
      terminated,
      backendGone,
      victimRejected,
      otherQueryUnaffected,
      recovery,
      destroyed,
      closedSessionsGone,
    };
  } finally {
    // Release the observer's advisory lock even when a scenario assertion would fail.
    await bounded(destroyDb(observer), 'observer cleanup');
    if (!destroyed) await bounded(destroyDb(db), 'failed scenario cleanup');
  }
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
}
try {
  const result = await run(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request);
  process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(
    `${REPORT_PREFIX}${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
}
