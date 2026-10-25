// B1-01zzi brief B.1: each module exports its read-only fund port from its own index.ts (the worker
// reaches other modules only through it), and the port reads only its own module's fund tables.
// Called on a Kysely that compiles and logs every query but never connects (each query answers one
// row whose every column is the number string '0', kit numericRow; the values are not checked
// here): no statement writes, and none reads the database's clock ("now" is the injected Clock
// only). The counts themselves are checked against PostgreSQL in
// ports.int.test.ts.
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import * as ordersIndex from '../../../../apps/api/src/modules/orders/index.ts';
import * as payoutIndex from '../../../../apps/api/src/modules/payout/index.ts';
import * as settlementIndex from '../../../../apps/api/src/modules/settlement/index.ts';
import { readOrderSyncPendingOpen } from '../../../../apps/api/src/modules/orders/application/metrics-read.ts';
import { readPayoutFundMetrics } from '../../../../apps/api/src/modules/payout/application/metrics-read.ts';
import { readSettlementFundMetrics } from '../../../../apps/api/src/modules/settlement/application/metrics-read.ts';
import {
  FUND_TABLES,
  NOW,
  PORT_TABLES,
  SQL_CLOCK,
  WRITE_SQL,
  mentions,
  numericRow,
  recordingDb,
} from './kit.ts';

type Module = keyof typeof PORT_TABLES;

/** The queries one port call compiles (its result over the stand-in's '0' rows is not checked). */
async function queriesOf(call: (db: ReturnType<typeof recordingDb>) => Promise<unknown>) {
  const queries: string[] = [];
  await Promise.resolve()
    .then(() => call(recordingDb(queries, () => [numericRow()])))
    .catch(() => undefined);
  return queries;
}

function expectOwnTablesOnly(module: Module, queries: readonly string[]): void {
  expect(queries.length, `${module}: the port runs SQL`).toBeGreaterThan(0);
  for (const table of PORT_TABLES[module]) {
    expect(
      queries.some((q) => mentions(q, table)),
      `${module} reads ${table}`,
    ).toBe(true);
  }
  const foreign = FUND_TABLES.filter(
    (table) =>
      !(PORT_TABLES[module] as readonly string[]).includes(table) &&
      queries.some((q) => mentions(q, table)),
  );
  expect(foreign, `${module} reads another module's fund table`).toEqual([]);
  expect(
    queries.filter((q) => WRITE_SQL.test(q)),
    `${module} writes`,
  ).toEqual([]);
  expect(
    queries.filter((q) => SQL_CLOCK.test(q)),
    `${module} reads the SQL clock`,
  ).toEqual([]);
}

it('[AC-B1-01zzi#7] 三个只读端口经各自模块 index.ts 导出；只读本模块的表、不写、不读数据库时钟', async () => {
  expect(ordersIndex.readOrderSyncPendingOpen).toBe(readOrderSyncPendingOpen);
  expect(settlementIndex.readSettlementFundMetrics).toBe(readSettlementFundMetrics);
  expect(payoutIndex.readPayoutFundMetrics).toBe(readPayoutFundMetrics);

  const clock = new FixedClock(NOW);
  expectOwnTablesOnly('orders', await queriesOf((db) => ordersIndex.readOrderSyncPendingOpen(db)));
  expectOwnTablesOnly(
    'settlement',
    await queriesOf((db) => settlementIndex.readSettlementFundMetrics(db, clock)),
  );
  expectOwnTablesOnly('payout', await queriesOf((db) => payoutIndex.readPayoutFundMetrics(db)));
});
