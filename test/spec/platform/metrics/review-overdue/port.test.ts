// B2-05o: payout's read-only review overdue port, exported from payout's index.ts (the worker
// reaches other modules only through it). Called on a Kysely that compiles and logs every query but
// never connects (B1-01zzi's recordingDb): it reads app.withdrawals by review_overdue_at and the
// two counted statuses, reads no other module's fund table, writes nothing and reads no database
// clock. A failed read rejects (it is never turned into 0). The count itself is checked against
// PostgreSQL in port.int.test.ts.
import { expect, it } from 'vitest';
import * as payoutIndex from '../../../../../apps/api/src/modules/payout/index.ts';
import {
  FUND_TABLES,
  SQL_CLOCK,
  WRITE_SQL,
  mentions,
  numericRow,
  recordingDb,
} from '../../fund-metrics/kit.ts';
import { COUNTED_STATUSES, isOverdueRead } from './kit.ts';

/** The queries one call compiles (its result over the stand-in's '0' rows is not checked). */
async function queriesOf(): Promise<string[]> {
  const queries: string[] = [];
  await Promise.resolve()
    .then(() => payoutIndex.readPayoutReviewOverdue(recordingDb(queries, () => [numericRow()])))
    .catch(() => undefined);
  return queries;
}

it('[AC-B2-05o#1] payout 端口经 payout/index.ts 导出：只读 withdrawals，按 review_overdue_at 与 PENDING_REVIEW / APPROVED 取数；不读别的模块的资金表、不写、不读数据库时钟', async () => {
  expect(typeof payoutIndex.readPayoutReviewOverdue, 'exported from payout/index.ts').toBe(
    'function',
  );
  const queries = await queriesOf();
  expect(queries.length, 'the port runs SQL').toBeGreaterThan(0);
  expect(queries.some(isOverdueRead), 'reads withdrawals by review_overdue_at').toBe(true);
  // The statuses may be literals or bound parameters; the read filters on status either way.
  expect(
    queries.some((q) => isOverdueRead(q) && /\bstatus\b/.test(q)),
    `the overdue read filters on status (${COUNTED_STATUSES.join(', ')})`,
  ).toBe(true);
  const foreign = FUND_TABLES.filter(
    (table) => table !== 'withdrawals' && queries.some((q) => mentions(q, table)),
  );
  expect(foreign, 'reads another module fund table').toEqual([]);
  expect(
    queries.filter((q) => WRITE_SQL.test(q)),
    'writes',
  ).toEqual([]);
  expect(
    queries.filter((q) => SQL_CLOCK.test(q)),
    'reads the SQL clock',
  ).toEqual([]);
});

it('[AC-B2-05o#2] 端口的库读失败时端口拒绝（原错误），不以 0 代替', async () => {
  const failure = new Error('stand-in: withdrawals unavailable');
  const queries: string[] = [];
  const db = recordingDb(queries, () => {
    throw failure;
  });
  await expect(
    Promise.resolve().then(() => payoutIndex.readPayoutReviewOverdue(db)),
  ).rejects.toThrow(failure.message);
  expect(queries.some(isOverdueRead), 'the failing read was the overdue one').toBe(true);
});
