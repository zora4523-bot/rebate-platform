import type { DB } from '@couli/db';
import type { CompiledQuery, Kysely, Transaction } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import type { RootLogger } from '../logging/logger.ts';
import { createQueueRuntime } from './runtime.ts';
import type { QueueRuntime, QueueSpec } from './types.ts';

// Only the schema-check query builder is replaced. The runtime uses real pg-boss
// cache/create/update/send logic, but every SQL statement reaches this memory connection.
vi.mock('kysely', async (original) => ({
  ...(await original<typeof import('kysely')>()),
  sql: () => ({ execute: async () => ({ rows: [{ version: 42 }] }) }),
}));
const runtimes: QueueRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  vi.useRealTimers();
});

function fixture(existing: boolean) {
  vi.useFakeTimers();
  const catalog: QueueSpec[] = ['payout', 'notify'].map((name) => ({
    name,
    policy: name === 'payout' ? 'exclusive' : 'standard',
    retryLimit: 2,
    retryDelaySeconds: 1,
    retryBackoff: false,
    retryDelayMaxSeconds: null,
    expireInSeconds: 1,
    retentionSeconds: 60,
    deleteAfterSeconds: 60,
    deadLetter: null,
  }));
  const rows = catalog.map((spec) => ({ ...spec, partition: false, table: 'job' }));
  const installed = new Set(existing ? catalog.map((spec) => spec.name) : []);
  const executeQuery = vi.fn(async (query: CompiledQuery) => {
    const sql = query.sql;
    if (sql.includes('to_regclass')) return { rows: [{ name: 'pgboss.version' }] };
    if (/SELECT version FROM/i.test(sql)) return { rows: [{ version: 42 }] };
    if (sql === 'SELECT version()') return { rows: [{ version: 'PostgreSQL' }] };
    if (sql.includes('FROM pgboss.queue q')) {
      const names = query.parameters[0] as string[] | undefined;
      return {
        rows: rows.filter((row) => installed.has(row.name) && (!names || names.includes(row.name))),
      };
    }
    if (sql.includes('pgboss.create_queue')) {
      for (const spec of catalog) {
        if (sql.includes(`'${spec.name}'`)) installed.add(spec.name);
      }
    }
    return { rows: [] };
  });
  const runtime = createQueueRuntime({
    entry: 'api',
    db: { executeQuery } as unknown as Kysely<DB>,
    logger: { warn: vi.fn(), error: vi.fn() } as unknown as RootLogger,
    catalog,
    plan: { api: [], stream: [], admin: [], worker: [], payout: [] },
  });
  runtimes.push(runtime);
  return { runtime, executeQuery, catalog };
}

it.each([true, false])(
  '[AC-B1-01g#5] 已有队列=%s：启动后并行事务首次入队不再申请池连接',
  async (existing) => {
    const { runtime, executeQuery, catalog } = fixture(existing);
    await runtime.start();
    executeQuery.mockClear();
    executeQuery.mockRejectedValue(new Error('all pool connections held by business transactions'));
    const transactionQuery = vi.fn(async () => ({ rows: [{ id: 'inserted' }] }));
    const trx = {
      isTransaction: true,
      executeQuery: transactionQuery,
    } as unknown as Transaction<DB>;
    const results = await Promise.all(
      catalog.flatMap((spec) =>
        Array.from({ length: 3 }, (_, i) =>
          runtime.send(
            spec.name,
            'job.run',
            {},
            {
              trx,
              ...(spec.policy === 'exclusive' ? { singletonKey: `key:${i}` } : {}),
            },
          ),
        ),
      ),
    );
    expect(results).toEqual(Array.from({ length: 6 }, () => 'inserted'));
    expect(transactionQuery).toHaveBeenCalledTimes(6);
    expect(executeQuery).not.toHaveBeenCalled();
  },
);
