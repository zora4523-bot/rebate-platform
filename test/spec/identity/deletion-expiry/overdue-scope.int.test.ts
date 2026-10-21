// B1-15f (rule-test review r1, S2 ×2): the 15-working-day alarm (08 BR-ID-27; brief §9.2 #5
// 「(apply_at, id) keyset 分批…一轮内日历按 (app_id, 年) 只读一次」).
//   - keyset batches: with batchSize 2, three overdue requests (cooling and processing) each get
//     their alarm in one round;
//   - the calendar cache is per (app_id, year): two apps with different 2026 calendars, each read
//     once per round, each request's deadline_at follows its own app's calendar.
// Synthetic calendars (not a platform recording). Apply 2026-09-28 10:00 +08:00, 15 working days:
//   National Day 10-01..10-07 off with the make-up Saturday 10-10 → 2026-10-23T16:00Z;
//   the same holidays without a make-up day → 2026-10-26T16:00Z.
// The runner is built in each test body (baseline red: NotImplemented) over kit.ts's database,
// clock, logger and per-user tables, with a calendar port keyed by (app_id, key).
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  OVERDUE,
  close,
  instant,
  open,
  owner,
  reset,
  seedRequest,
  warnings,
  type BalancePort,
  type CalendarPort,
  type Kit,
  type PortInput,
  type WithdrawalsPort,
} from './kit.ts';

let database: TestDatabase;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  kit = await open(database);
}, 180_000);
beforeEach(async () => {
  await reset(kit);
});
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    await database?.drop();
  }
});

const APPLY_AT = '2026-09-28T02:00:00.000Z';
const NATIONAL_DAY = [
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
];
const key = (input: PortInput) => `${input.appId}/${input.userId}`;

function runnerWith(calendars: Map<string, unknown>, batchSize?: number) {
  const calls: { appId: string; key: string }[] = [];
  const calendar: CalendarPort = {
    configValue(appId, configKey) {
      calls.push({ appId, key: configKey });
      const k = `${appId}:${configKey}`;
      return Promise.resolve(calendars.has(k) ? { value: calendars.get(k), version: 1 } : null);
    },
  };
  const withdrawals: WithdrawalsPort = {
    hasNonTerminal: (_trx: Transaction<DB>, input: PortInput) =>
      Promise.resolve(kit.nonTerminal.get(key(input)) ?? false),
  };
  const balance: BalancePort = {
    availableFen: (_trx: Transaction<DB>, input: PortInput) =>
      Promise.resolve(kit.balances.get(key(input)) ?? 0n),
  };
  const runner = kit.api.createDeletionExpiry({
    db: kit.db,
    clock: kit.clock,
    logger: kit.logger,
    withdrawals,
    balance,
    calendar,
    ...(batchSize === undefined ? {} : { batchSize }),
  });
  return { runner, calls };
}

function configure(calendars: Map<string, unknown>, appId: string, makeup: readonly string[]) {
  calendars.set(`${appId}:calendar.cn_holidays.2026`, NATIONAL_DAY);
  calendars.set(`${appId}:calendar.cn_makeup_workdays.2026`, makeup);
}

it('[AC-B1-15f#40] 超时扫描按 (apply_at, id) 分批读完：batchSize=2 时三张超时单（cooling 与 processing）同一轮各告一次', async () => {
  const calendars = new Map<string, unknown>();
  const a = await owner(kit.db, { status: 'deleting' });
  const b = await owner(kit.db, { appId: a.appId, status: 'deleting' });
  const c = await owner(kit.db, { appId: a.appId });
  configure(calendars, a.appId, ['2026-10-10']);
  const ra = await seedRequest(kit.db, a, {
    status: 'processing',
    applyAt: new Date(APPLY_AT),
  });
  const rb = await seedRequest(kit.db, b, {
    status: 'processing',
    applyAt: new Date(Date.parse(APPLY_AT) + 60_000),
  });
  // Still cooling: its withdrawal is not terminal, so the expiry defers it (and it stays cooling).
  const rc = await seedRequest(kit.db, c, { applyAt: new Date(Date.parse(APPLY_AT) + 120_000) });
  kit.setNonTerminal(c, true);
  // batchSize also bounds the overdue scan's pages: ordered by (apply_at, id) the first page holds
  // exactly ra and rb, so rc is only reached through the next keyset page. An implementation that
  // reads one page of overdue requests per round never alarms rc and fails below.
  const { runner } = runnerWith(calendars, 2);
  kit.clock.set('2026-10-23T16:00:00.000Z');
  await runner.runOnce();
  const lines = warnings(kit, OVERDUE, a.appId);
  expect(lines.map((line) => line['deletion_request_id']).sort()).toEqual(
    [ra.id, rb.id, rc.id].sort(),
  );
  expect(
    Object.fromEntries(lines.map((line) => [line['deletion_request_id'], line['status']])),
  ).toEqual({ [ra.id]: 'processing', [rb.id]: 'processing', [rc.id]: 'cooling' });
});

it('[AC-B1-15f#41] 日历按 (app_id, 年) 缓存：两个 app 不同调休配置各读一次、各按自己的日历算截止', async () => {
  const calendars = new Map<string, unknown>();
  const withMakeup = await owner(kit.db, { status: 'deleting' });
  const withMakeupTwo = await owner(kit.db, { appId: withMakeup.appId, status: 'deleting' });
  const noMakeup = await owner(kit.db, { status: 'deleting' });
  const noMakeupTwo = await owner(kit.db, { appId: noMakeup.appId, status: 'deleting' });
  configure(calendars, withMakeup.appId, ['2026-10-10']);
  configure(calendars, noMakeup.appId, []);
  const rows = {
    first: await seedRequest(kit.db, withMakeup, {
      status: 'processing',
      applyAt: new Date(APPLY_AT),
    }),
    second: await seedRequest(kit.db, withMakeupTwo, {
      status: 'processing',
      applyAt: new Date(APPLY_AT),
    }),
    third: await seedRequest(kit.db, noMakeup, {
      status: 'processing',
      applyAt: new Date(APPLY_AT),
    }),
    fourth: await seedRequest(kit.db, noMakeupTwo, {
      status: 'processing',
      applyAt: new Date(APPLY_AT),
    }),
  };
  const { runner, calls } = runnerWith(calendars);
  // 2026-10-23 24:00 +08:00: only the app with the make-up Saturday is overdue.
  kit.clock.set('2026-10-23T16:00:00.000Z');
  await runner.runOnce();
  for (const appId of [withMakeup.appId, noMakeup.appId]) {
    expect(
      calls.filter((call) => call.appId === appId && call.key === 'calendar.cn_holidays.2026'),
    ).toHaveLength(1);
    expect(
      calls.filter(
        (call) => call.appId === appId && call.key === 'calendar.cn_makeup_workdays.2026',
      ),
    ).toHaveLength(1);
  }
  const made = warnings(kit, OVERDUE, withMakeup.appId);
  expect(made.map((line) => line['deletion_request_id']).sort()).toEqual(
    [rows.first.id, rows.second.id].sort(),
  );
  for (const line of made) {
    expect(instant(line['deadline_at'])).toBe(Date.parse('2026-10-23T16:00:00.000Z'));
  }
  expect(warnings(kit, OVERDUE, noMakeup.appId)).toEqual([]);
  // 2026-10-26 24:00 +08:00: the other app's requests reach their own deadline.
  kit.clock.set('2026-10-26T16:00:00.000Z');
  await runner.runOnce();
  const own = warnings(kit, OVERDUE, noMakeup.appId);
  expect(own.map((line) => line['deletion_request_id']).sort()).toEqual(
    [rows.third.id, rows.fourth.id].sort(),
  );
  for (const line of own) {
    expect(instant(line['deadline_at'])).toBe(Date.parse('2026-10-26T16:00:00.000Z'));
  }
  // §9.2 #6: the dedup set is cleared at the +08:00 day change (2026-10-24 → 2026-10-27), so the
  // first app's two requests, still overdue, are reported once more on the new day: 4 lines.
  const repeated = warnings(kit, OVERDUE, withMakeup.appId);
  expect(repeated).toHaveLength(4);
  expect(repeated.map((line) => line['deletion_request_id']).sort()).toEqual(
    [rows.first.id, rows.first.id, rows.second.id, rows.second.id].sort(),
  );
  for (const line of repeated) {
    expect(instant(line['deadline_at'])).toBe(Date.parse('2026-10-23T16:00:00.000Z'));
  }
});
