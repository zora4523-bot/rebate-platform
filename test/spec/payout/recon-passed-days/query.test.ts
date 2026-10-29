// B2-07d (task brief §9.2 #3 #5; 编排裁定 D10-408 ③; apps/api/AGENTS.md hard rule 2): the port reads
// on the handle the caller gives and nowhere else, only reads (no write, no row lock, no table lock),
// takes the day from the injected Clock (no database clock), and asks only about the caller's app on
// the alipay channel — app.payout_recon_runs admits no other channel today (its CHECK), so the
// channel filter is pinned here on the statements, not by rows. Unit test: a Kysely handle on
// Kysely's DummyDriver (every statement answers no rows), no database, no port.
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { expect, it } from 'vitest';
import { createReconPassedDays } from '../../../../apps/api/src/modules/payout/application/recon-passed-days.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { CHANNEL, NOW } from './kit.ts';

const APP = 'b207d-query-app';

interface Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

function recording() {
  const statements: Statement[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(event) {
      statements.push({ sql: event.query.sql, parameters: event.query.parameters });
    },
  });
  return { db, statements };
}

const WRITES_OR_LOCKS =
  /\b(insert|update|delete|truncate|merge|lock\s+table|for\s+(update|share|no\s+key\s+update|key\s+share))\b/iu;
const DATABASE_CLOCK =
  /\b(now|current_date|current_timestamp|localtimestamp|clock_timestamp|statement_timestamp|transaction_timestamp)\b/iu;

it('[AC-B2-07d#15] 只在调用方给的 handle 上只读：读 payout_recon_runs、不写不锁、不取库里的时间，只问本 app 的 alipay', async () => {
  const port = createReconPassedDays({ clock: new FixedClock(NOW) });
  const r = recording();
  try {
    // The answer on no rows is count.int.test.ts's; here only the statements are looked at.
    await port.passedDays(APP, r.db).then(
      () => undefined,
      () => undefined,
    );
  } finally {
    await r.db.destroy();
  }
  const reads = r.statements.filter((statement) => /payout_recon_runs/u.test(statement.sql));
  expect(reads.length, 'statements on payout_recon_runs').toBeGreaterThan(0);
  for (const statement of r.statements) {
    expect(statement.sql).not.toMatch(WRITES_OR_LOCKS);
    expect(statement.sql).not.toMatch(DATABASE_CLOCK);
  }
  for (const statement of reads) {
    const names = (value: string) =>
      statement.parameters.includes(value) || statement.sql.includes(`'${value}'`);
    expect(names(APP), `app filter: ${statement.sql}`).toBe(true);
    expect(names(CHANNEL), `channel filter: ${statement.sql}`).toBe(true);
  }
});

it('[AC-B2-07d#16] 端口不自带库连接：同一个端口对两个 handle 各问一次，语句各自落在被问的那个 handle 上', async () => {
  const port = createReconPassedDays({ clock: new FixedClock(NOW) });
  const first = recording();
  const second = recording();
  try {
    await port.passedDays(APP, first.db).then(
      () => undefined,
      () => undefined,
    );
    const afterFirst = second.statements.length;
    await port.passedDays(`${APP}-2`, second.db).then(
      () => undefined,
      () => undefined,
    );
    expect(afterFirst).toBe(0);
  } finally {
    await Promise.all([first.db.destroy(), second.db.destroy()]);
  }
  expect(first.statements.length).toBeGreaterThan(0);
  expect(second.statements.length).toBeGreaterThan(0);
  expect(first.statements.some((statement) => statement.parameters.includes(`${APP}-2`))).toBe(
    false,
  );
  expect(second.statements.some((statement) => statement.parameters.includes(APP))).toBe(false);
});
