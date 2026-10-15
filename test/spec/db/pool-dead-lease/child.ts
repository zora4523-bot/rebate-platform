// Real PG only; launched by default-pool.int.test.ts, never imported at runtime.
// No process exception handlers or instrumentation of the default pool/clients.
import { createRequire } from 'node:module';
import type { EventEmitter } from 'node:events';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export interface Request {
  readonly url: string;
  readonly applicationName: string;
  readonly max: 1 | 2;
}

const LIMIT_MS = 8000;
const BIG = 9007199254740993n;

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

async function sessions(observer: Kysely<DB>, name: string) {
  return (
    await sql<{ pid: number }>`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = ${name}
    `.execute(observer)
  ).rows;
}

async function probe(db: Kysely<DB>) {
  const result = await sql<{ value: number; pid: number; big: unknown }>`
    SELECT 1 AS value, pg_backend_pid() AS pid, 9007199254740993::int8 AS big
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) throw new Error('probe returned no row');
  return { value: row.value, pid: row.pid, bigint: row.big === BIG };
}

// The driver belongs to @couli/db; no new direct dependency for the test package.
type Factory = NonNullable<Parameters<typeof createDb>[0]['poolFactory']>;
type FactoryPool = ReturnType<Factory> & EventEmitter;
type FactoryClient = Awaited<ReturnType<FactoryPool['connect']>> & EventEmitter;
const requireDb = createRequire(new URL('../../../../packages/db/package.json', import.meta.url));
const { Pool } = requireDb('pg') as {
  Pool: new (config: Parameters<Factory>[0]) => FactoryPool;
};

function snapshot(emitter: EventEmitter) {
  return new Map(emitter.eventNames().map((event) => [event, emitter.listeners(event)]));
}

function listenersUnchanged(emitter: EventEmitter, before: ReturnType<typeof snapshot>) {
  return (
    emitter.eventNames().length === before.size &&
    [...before].every(([event, listeners]) => {
      const after = emitter.listeners(event);
      return (
        after.length === listeners.length && after.every((fn, index) => fn === listeners[index])
      );
    })
  );
}

async function factoryFacts(url: string, name: string, preexisting: boolean) {
  let pool: FactoryPool | undefined;
  let client: FactoryClient | undefined;
  let poolBaseline: ReturnType<typeof snapshot> = new Map();
  let clientBaseline: ReturnType<typeof snapshot> = new Map();
  let calls = 0;
  const ownedListener = (): void => {
    calls += 1;
  };
  const db = createDb({
    connectionString: url,
    applicationName: `${name}-factory`,
    max: 1,
    poolFactory(config) {
      pool = new Pool(config);
      if (preexisting) pool.on('error', ownedListener);
      pool.on('connect', (connected: FactoryClient) => {
        if (preexisting) connected.on('error', ownedListener);
      });
      const connect = pool.connect.bind(pool);
      pool.connect = async () => {
        client = (await connect()) as FactoryClient;
        // pg-pool's own idle listener has already been removed at this point.
        clientBaseline = snapshot(client);
        return client;
      };
      poolBaseline = snapshot(pool);
      return pool;
    },
  });
  try {
    return await bounded(
      db.connection().execute(async (connection) => {
        const first = await probe(connection);
        const listeners = client?.listeners('error') ?? [];
        const unchanged =
          pool !== undefined &&
          client !== undefined &&
          listenersUnchanged(pool, poolBaseline) &&
          listenersUnchanged(client, clientBaseline);
        // A caller-owned error handler need not poison a factory client's connection.
        // Emitting here is restricted to the factory path; default clients are untouched.
        if (preexisting) {
          pool?.emit('error', new Error('factory-owned pool notification'));
          client?.emit('error', new Error('factory-owned client notification'));
        }
        const second = await probe(connection);
        return {
          poolListeners: pool?.listenerCount('error'),
          clientListeners: listeners.length,
          originalListenersPreserved:
            unchanged &&
            pool !== undefined &&
            client !== undefined &&
            listenersUnchanged(pool, poolBaseline) &&
            listenersUnchanged(client, clientBaseline) &&
            (!preexisting ||
              (listeners.includes(ownedListener) &&
                pool?.listeners('error').includes(ownedListener))),
          ownedCalls: calls,
          sameBackend: first.pid === second.pid,
          bigint: first.bigint && second.bigint,
        };
      }),
      'factory ownership and int8',
    );
  } finally {
    await bounded(destroyDb(db), 'factory cleanup');
  }
}

async function recover(db: Kysely<DB>, observer: Kysely<DB>, request: Request, deadPid: number) {
  // Do not retry failures: in particular, the FIRST query after release must succeed.
  const sequential = [];
  for (let index = 0; index < request.max + 1; index += 1) {
    sequential.push(await bounded(probe(db), `sequential recovery ${index}`));
  }
  const concurrent = await bounded(
    Promise.all(Array.from({ length: request.max * 2 + 1 }, () => probe(db))),
    'more concurrent queries than pool slots',
  );
  // Occupy every slot at once so one healthy connection cannot mask a broken slot.
  let arrived = 0;
  let open = (): void => {};
  const barrier = new Promise<void>((resolve) => {
    open = resolve;
  });
  const slots = await bounded(
    Promise.all(
      Array.from({ length: request.max }, () =>
        db.connection().execute(async (connection) => {
          const row = await probe(connection);
          arrived += 1;
          if (arrived === request.max) open();
          await bounded(barrier, 'all pool slots borrowed');
          return row;
        }),
      ),
    ),
    'all pool slots recover',
  );
  const live = await sessions(observer, request.applicationName);
  const rows = [...sequential, ...concurrent, ...slots];
  return {
    sequential: sequential.map((row) => row.value),
    concurrent: concurrent.map((row) => row.value),
    distinctSlots: new Set(slots.map((row) => row.pid)).size,
    allBackendsLive: rows.every((row) => live.some((session) => session.pid === row.pid)),
    deadBackendReused: rows.some((row) => row.pid === deadPid),
    deadBackendPresent: live.some((session) => session.pid === deadPid),
    withinMax: live.length > 0 && live.length <= request.max,
    bigint: rows.every((row) => row.bigint),
  };
}

async function run(request: Request) {
  const { url, applicationName: name, max } = request;
  const db = createDb({ connectionString: url, max, applicationName: name });
  const observer = createDb({ connectionString: url, max: 1, applicationName: `${name}-observer` });
  try {
    const factories = [await factoryFacts(url, name, false), await factoryFacts(url, name, true)];
    const lease = await bounded(
      db.connection().execute(async (connection) => {
        const before = await probe(connection);
        // Locate the backend by the unique application_name using a separate connection.
        const candidates = await sessions(observer, name);
        const victim = candidates.find((session) => session.pid === before.pid);
        if (victim === undefined) throw new Error('borrowed backend missing before termination');
        // Self-termination guarantees FATAL belongs to an active query. Killing from
        // the observer and waiting would let pg mark an idle client unqueryable,
        // hiding the bug. Do not wait for socket end or query the observer after this.
        const queryError = await sql`SELECT pg_terminate_backend(pg_backend_pid())`
          .execute(connection)
          .then(
            () => null,
            (error: unknown) => ({
              ...errorDetails(error),
              code: error instanceof Error && 'code' in error ? String(error.code) : null,
              severity:
                error instanceof Error && 'severity' in error ? String(error.severity) : null,
            }),
          );
        // Return normally after catching FATAL, as with a caught unlock failure.
        return {
          deadPid: victim.pid,
          bigintBefore: before.bigint,
          queryError,
        };
      }),
      'terminate and normally release borrowed connection',
    );
    // Immediately issue the first recovery query: no timers or observer round trips.
    // Capture recovery separately, so the test asserts the actual reuse failure rather
    // than accepting an arbitrary child/import/setup failure as the expected red.
    const recovery = await recover(db, observer, request, lease.deadPid).then(
      (facts) => ({ facts, error: null }),
      (error: unknown) => ({ facts: null, error: errorDetails(error) }),
    );
    return { factories, lease, recovery };
  } finally {
    await bounded(destroyDb(db), 'default pool cleanup');
    await bounded(destroyDb(observer), 'observer cleanup');
  }
}

function errorDetails(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
}

export type Report = Awaited<ReturnType<typeof run>>;

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
}
try {
  const report = await run(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request);
  process.stdout.write(`B1-01zzc-result:${JSON.stringify(report)}\n`);
} catch (error) {
  process.stdout.write(`B1-01zzc-fatal:${JSON.stringify(errorDetails(error))}\n`);
  process.exitCode = 1;
}
