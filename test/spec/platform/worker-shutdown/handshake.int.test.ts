// B2-15q deterministic reproduction (claude-independent, D10-553) of the afterAll hang of
// spec/payment/recon-schedule/bootstrap.int.test.ts. Kysely's PostgresDriver.destroy() clears its
// pool field before `await pool.end()`, and acquireConnection reads that field again after
// `await pool.connect()`. A tick waiting for a connection during destroyDb therefore throws once
// the connection arrives, never releases the client, and pool.end() waits for it forever.
//
// Real PostgreSQL as couli_app, real createDb, real pg pool, real tick. The pool handed to createDb
// holds its connect() between the finished connection and Kysely receiving it, which makes that
// window deterministic: the process then does what the entry does, the module's stop and destroyDb,
// and the gate opens once pool.end() has been reached (or after a short wait, on a stop that rightly
// waits for the tick). destroyDb must return within 10 seconds. On the old modules the stop returns
// at once, so the wait runs out and the assertion is red; the test then releases the lost client by
// hand, so the run ends. `pg` is resolved through packages/db, whose dependency it is. Fake timers
// cover the module timers only. Top-level it() only (规划/11 §4.3).
import { createRequire } from 'node:module';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely, PostgresPool } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  TIMERS,
  deferred,
  fakeModuleTimers,
  fixedClock,
  idleQueue,
  loadTargets,
  recordingLogger,
  within,
  type Lifecycle,
  type Target,
  type TimerName,
} from './kit.ts';

/** The limit of the rule: the stop and destroyDb together. */
const DESTROY_LIMIT_MS = 10_000;
/** How long the first statement may take to get its connection (real time). */
const CONNECT_LIMIT_MS = 5_000;
/** How long the gate stays shut for a stop that waits for the tick (real time). */
const END_WAIT_MS = 500;
/** How long the shutdown may take once the lost client is released by hand (real time). */
const ABANDON_WAIT_MS = 3_000;

interface PgClientLike {
  release(destroy?: boolean): void;
}

interface PgPoolLike {
  readonly totalCount: number;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

const requireFromDb = createRequire(
  new URL('../../../../packages/db/package.json', import.meta.url),
);
const pg = requireFromDb('pg') as { Pool: new (config: unknown) => PgPoolLike };

let database: TestDatabase;
let targets: Record<TimerName, Target>;

beforeAll(async () => {
  targets = await loadTargets();
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(() => {
  fakeModuleTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

interface HeldDb {
  readonly db: Kysely<DB>;
  /** Resolved when a connection is established and held back from Kysely. */
  readonly connected: Promise<void>;
  /** Resolved when pool.end() has been called. */
  readonly ending: Promise<void>;
  /** Hands the held connection to Kysely. */
  finish(): void;
  /** Releases by hand the clients Kysely lost, so that pool.end() can return. */
  abandon(): void;
  /** Clients the pool still counts. */
  total(): number;
}

function heldDb(url: string): HeldDb {
  const connected = deferred();
  const ending = deferred();
  const gate = deferred();
  const clients = new Set<PgClientLike>();
  const pools: PgPoolLike[] = [];
  const db = createDb({
    connectionString: url,
    max: 2,
    poolFactory: (config) => {
      const real = new pg.Pool(config);
      // The lost client's session ends with the forced drop at the latest; not this test's error.
      real.on('error', () => undefined);
      pools.push(real);
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'connect') {
            return async () => {
              const client = await target.connect();
              clients.add(client);
              connected.resolve();
              await gate.promise;
              return client;
            };
          }
          if (prop === 'end') {
            return () => {
              ending.resolve();
              return target.end();
            };
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function'
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      }) as unknown as PostgresPool;
    },
  });
  return {
    db,
    connected: connected.promise,
    ending: ending.promise,
    finish: () => {
      gate.resolve();
    },
    abandon: () => {
      for (const client of clients) client.release(true);
    },
    total: () => pools.reduce((sum, pool) => sum + pool.totalCount, 0),
  };
}

/** What the entry does on shutdown: the module's stop, then the database. */
async function shutDown(timer: Lifecycle, db: Kysely<DB>): Promise<void> {
  await timer.onModuleDestroy();
  await destroyDb(db);
}

it.each(TIMERS)(
  '[AC-B2-15q#5] %s：tick 的语句正等新连接时调模块 stop 再 destroyDb，必须在 10 秒内返回，连接池不留连接',
  async (name) => {
    const target = targets[name];
    const held = heldDb(database.urlFor('couli_app'));
    const { logger } = recordingLogger();
    const timer = target.build({
      db: held.db,
      clock: fixedClock(),
      queue: idleQueue(),
      logger,
    });

    timer.onApplicationBootstrap();
    vi.advanceTimersByTime(target.seedDelayMs);
    expect(await within(held.connected, CONNECT_LIMIT_MS), 'fixture: the tick connects').toBe(
      'done',
    );

    const shutdown = shutDown(timer, held.db);
    await within(held.ending, END_WAIT_MS);
    held.finish();
    const outcome = await within(shutdown, DESTROY_LIMIT_MS);
    if (outcome === 'timeout') {
      held.abandon();
      await within(shutdown, ABANDON_WAIT_MS);
    }

    expect(outcome, 'stop and destroyDb must return within 10 seconds').toBe('done');
    expect(held.total(), 'the pool kept a connection').toBe(0);
  },
);
