// Real PG via @couli/db/testing's cloned database (TEST_PG_ADMIN_URL in global setup).
// Only the pg wire fault is synthetic; controller, favorites and idempotency are production code.
import { createRequire } from 'node:module';
import { createDb } from '@couli/db';
import type { TestDatabase } from '@couli/db/testing';
import type { PostgresPool } from 'kysely';
import { createFavoritesService } from '../../../../apps/api/src/modules/catalog/favorites/service.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createIdempotency } from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import { controller, initialTime, replySink, request, userId, type Operation } from './kit.ts';

interface PgClient {
  query(text: unknown, parameters?: unknown): Promise<{ rows: Record<string, unknown>[] }>;
  on(event: 'error', listener: () => void): unknown;
}
interface PgPool {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): unknown;
}
const requireDb = createRequire(new URL('../../../../packages/db/package.json', import.meta.url));
const pg = requireDb('pg') as { Pool: new (options: unknown) => PgPool };

type Fault = 'completed-write' | 'commit-ack' | 'none';
interface Snapshot {
  inside: unknown[];
  outside: string[];
  visibleRecords: string[];
  userLocks: number;
}

export function databaseFixture(database: TestDatabase, appId: string, fault: Fault) {
  const url = database.urlFor('couli_app');
  const observer = createDb({ connectionString: url, max: 4 });
  const clock = new FixedClock(initialTime);
  const state = {
    fault,
    cap: 500,
    completionFailures: 0,
    lostCommits: 0,
    favoriteWrites: 0,
    snapshot: null as Snapshot | null,
  };

  async function favorites() {
    return observer
      .selectFrom('favorites')
      .select(['id', 'product_key', 'created_at'])
      .where('app_id', '=', appId)
      .where('user_id', '=', userId)
      .orderBy('product_key')
      .execute();
  }
  async function records(key = 'favorite-write-0001') {
    return observer
      .selectFrom('idempotency_keys')
      .select(['status'])
      .where('app_id', '=', appId)
      .where('subject', '=', `u:${userId}`)
      .where('key', '=', key)
      .execute();
  }

  function wrapClient(client: PgClient): PgClient {
    let businessWritten = false;
    return new Proxy(client, {
      get(target, property) {
        if (property === 'query') {
          return async (text: unknown, parameters?: unknown) => {
            const statement = typeof text === 'string' ? text.trim().toLowerCase() : '';
            // Includes Kysely's "start transaction isolation level read committed".
            if (/^(begin|start transaction)\b/.test(statement)) businessWritten = false;
            const completed =
              /^(insert|update)\b/.test(statement) &&
              statement.includes('idempotency_keys') &&
              (statement.includes("'completed'") ||
                (Array.isArray(parameters) && parameters.includes('completed')));
            if (completed && state.fault === 'completed-write') {
              if (state.snapshot === null) {
                // Read with the very connection about to write completed, and a separate
                // connection. This distinguishes a shared uncommitted write from two commits.
                const inside = await target.query(
                  'SELECT product_key FROM app.favorites WHERE app_id = $1 AND user_id = $2::uuid ORDER BY product_key',
                  [appId, userId],
                );
                const locks = await target.query(
                  "SELECT count(*)::int AS n FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND objsubid = 1 AND granted",
                );
                state.snapshot = {
                  inside: inside.rows.map((row) => row['product_key']),
                  outside: (await favorites()).map((row) => row.product_key),
                  visibleRecords: (await records()).map((row) => row.status),
                  // Bigint advisory lock = favorites' per-user lock. The platform's
                  // two-int4 idempotency lock uses objsubid = 2 and cannot satisfy this.
                  userLocks: Number(locks.rows[0]?.['n']),
                };
              }
              state.completionFailures += 1;
              // Persistent until explicitly disarmed: standard mode retries completed writes.
              throw new Error('injected favorites completed-write failure');
            }
            const result = await target.query(text, parameters);
            if (/^(insert|delete)\b/.test(statement) && statement.includes('"favorites"')) {
              businessWritten = true;
              state.favoriteWrites += 1;
            }
            if (statement === 'commit' && businessWritten && state.fault === 'commit-ack') {
              state.fault = 'none';
              state.lostCommits += 1;
              // COMMIT has really succeeded, but its acknowledgement is lost. Arm only after
              // a favorite write: standard mode's earlier processing-claim commit is ignored.
              throw new Error('injected favorites commit acknowledgement loss');
            }
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }

  const db = createDb({
    max: 6,
    poolFactory(config) {
      const pool = new pg.Pool({ ...config, connectionString: url });
      pool.on('error', () => undefined);
      const clients = new WeakMap<PgClient, PgClient>();
      return new Proxy(pool, {
        get(target, property) {
          if (property === 'connect') {
            return async () => {
              const client = await target.connect();
              let wrapped = clients.get(client);
              if (wrapped === undefined) {
                client.on('error', () => undefined);
                wrapped = wrapClient(client);
                clients.set(client, wrapped);
              }
              return wrapped;
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      }) as unknown as PostgresPool;
    },
  });
  const options = {
    clock,
    config: { configValue: async () => ({ value: state.cap, version: 1 }) },
    cards: {
      fetch: async () => ({
        kind: 'unavailable' as const,
        reason: 'not_found' as const,
        title: null,
        image: null,
      }),
    },
    logger: { warn() {}, error() {} },
  };
  return {
    state,
    clock,
    favorites,
    records,
    otherEnd: createFavoritesService({ ...options, db: observer }),
    async seed(productKey: string, id: string) {
      await observer
        .insertInto('favorites')
        .values({
          id,
          app_id: appId,
          user_id: userId,
          platform: 'taobao',
          product_key: productKey,
          created_at: new Date(initialTime),
        })
        .execute();
    },
    async call(
      operation: Operation,
      trace = 'original-trace',
      changes: Partial<ReturnType<typeof request>> = {},
    ) {
      // Fresh services each time: replay must come from PG, not a process-local cache.
      const route = controller(
        createFavoritesService({ ...options, db }),
        createIdempotency({ ...options, db }),
      );
      const reply = replySink();
      await route[operation](
        { ...request(appId, 'favorite-write-0001', trace), ...changes },
        reply,
      );
      return { status: reply.status, body: reply.body };
    },
    async close() {
      await Promise.all([db.destroy(), observer.destroy()]);
    },
  };
}
