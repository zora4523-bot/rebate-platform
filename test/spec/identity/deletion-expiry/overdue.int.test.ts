// B1-15f: the 15-working-day alarm (08 BR-ID-27 「自 requested_at 起 ≤15 个工作日（按国家法定工作日历，含
// 调休）必须到 done」, 细则「最迟第 15 个工作日（国庆假期不计）完成」; BR-ID-36 口径「提交当日不计…第 N 个工作日
// 24:00（+08:00）」; brief §9.2 #5, #6; rule-test list item 10). The calendars below are synthetic
// configuration values (not a platform recording): 2026 National Day 10-01..10-07 off with the
// make-up Saturday 10-10; 2027 01-01 and 01-04 off with the make-up Saturday 01-09.
// Expected deadlines (24:00 +08:00 of the 15th working day after the +08:00 apply date):
//   apply 2026-09-28 10:00 +08:00 → 2026-10-23 24:00 (2026-10-23T16:00Z); without the make-up day
//     it would be 10-26, weekends only 10-19;
//   apply 2026-12-24 09:00 +08:00 → 2027-01-15 24:00 (2027-01-15T16:00Z), across the year.
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  DEFERRED,
  OVERDUE,
  close,
  fields,
  instant,
  open,
  owner,
  reset,
  seedRequest,
  warnings,
  type Kit,
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

function configureCalendars() {
  kit.calendarValues.set('calendar.cn_holidays.2026', [
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
    '2026-10-04',
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
  ]);
  kit.calendarValues.set('calendar.cn_makeup_workdays.2026', ['2026-09-20', '2026-10-10']);
  kit.calendarValues.set('calendar.cn_holidays.2027', ['2027-01-01', '2027-01-04']);
  kit.calendarValues.set('calendar.cn_makeup_workdays.2027', ['2027-01-09']);
}

const before = (iso: string) => new Date(Date.parse(iso) - 1);

it('[AC-B1-15f#15] 含调休：processing 单截止前一刻不告，到点告一次（五个字段），同日再跑不重复', async () => {
  configureCalendars();
  const o = await owner(kit.db, { status: 'deleting' });
  const row = await seedRequest(kit.db, o, {
    status: 'processing',
    applyAt: new Date('2026-09-28T02:00:00.000Z'),
  });
  const runner = kit.runner();
  kit.clock.set(before('2026-10-23T16:00:00.000Z'));
  await runner.runOnce();
  expect(warnings(kit, OVERDUE, o.appId)).toEqual([]);
  kit.clock.set('2026-10-23T16:00:00.000Z');
  await runner.runOnce();
  const lines = warnings(kit, OVERDUE, o.appId);
  expect(lines).toHaveLength(1);
  expect(Object.keys(fields(lines[0]!)).sort()).toEqual([
    'app_id',
    'apply_at',
    'deadline_at',
    'deletion_request_id',
    'status',
  ]);
  expect(lines[0]).toMatchObject({
    app_id: o.appId,
    deletion_request_id: row.id,
    status: 'processing',
  });
  expect(instant(lines[0]!['apply_at'])).toBe(Date.parse('2026-09-28T02:00:00.000Z'));
  expect(instant(lines[0]!['deadline_at'])).toBe(Date.parse('2026-10-23T16:00:00.000Z'));
  kit.clock.set('2026-10-23T16:30:00.000Z');
  await runner.runOnce();
  expect(warnings(kit, OVERDUE, o.appId)).toHaveLength(1);
});

it('[AC-B1-15f#16] 跨年：推迟中（仍 cooling）的单截止前一刻只有推迟告警，到点另告超时', async () => {
  configureCalendars();
  const o = await owner(kit.db);
  const row = await seedRequest(kit.db, o, { applyAt: new Date('2026-12-24T01:00:00.000Z') });
  kit.setNonTerminal(o, true);
  const runner = kit.runner();
  kit.clock.set(before('2027-01-15T16:00:00.000Z'));
  await runner.runOnce();
  expect(warnings(kit, DEFERRED, o.appId)).toHaveLength(1);
  expect(warnings(kit, OVERDUE, o.appId)).toEqual([]);
  kit.clock.set('2027-01-15T16:00:00.000Z');
  await runner.runOnce();
  const lines = warnings(kit, OVERDUE, o.appId);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    app_id: o.appId,
    deletion_request_id: row.id,
    status: 'cooling',
  });
  expect(instant(lines[0]!['deadline_at'])).toBe(Date.parse('2027-01-15T16:00:00.000Z'));
  // Both years' calendars were read for this app.
  const keys = kit.calendarCalls.filter((c) => c.appId === o.appId).map((c) => c.key);
  expect(keys).toEqual(expect.arrayContaining(['calendar.cn_holidays.2027']));
});

it('[AC-B1-15f#17] done 与 cancelled 的单即使早已超过 15 个工作日也不告警', async () => {
  configureCalendars();
  const done = await owner(kit.db);
  const cancelled = await owner(kit.db);
  await seedRequest(kit.db, done, {
    status: 'done',
    applyAt: new Date('2026-09-28T02:00:00.000Z'),
  });
  await seedRequest(kit.db, cancelled, {
    status: 'cancelled',
    applyAt: new Date('2026-09-28T02:00:00.000Z'),
  });
  kit.clock.set('2026-11-30T04:00:00.000Z');
  await kit.runner().runOnce();
  expect(warnings(kit, OVERDUE, done.appId)).toEqual([]);
  expect(warnings(kit, OVERDUE, cancelled.appId)).toEqual([]);
});

it('[AC-B1-15f#18] 未配置年份按周末计算并 warn（app_id、year，非申诉日志键）', async () => {
  const o = await owner(kit.db, { status: 'deleting' });
  const row = await seedRequest(kit.db, o, {
    status: 'processing',
    applyAt: new Date('2026-09-28T02:00:00.000Z'),
  });
  const runner = kit.runner();
  kit.clock.set(before('2026-10-19T16:00:00.000Z'));
  await runner.runOnce();
  expect(warnings(kit, OVERDUE, o.appId)).toEqual([]);
  const unconfigured = kit
    .logs()
    .filter(
      (line) =>
        line['level'] === 40 &&
        line['app_id'] === o.appId &&
        line['year'] === 2026 &&
        line['msg'] !== OVERDUE,
    );
  expect(unconfigured.length).toBeGreaterThanOrEqual(1);
  expect(fields(unconfigured[0]!)).toEqual({ app_id: o.appId, year: 2026 });
  expect(unconfigured[0]!['msg']).not.toBe('appeal_calendar_unconfigured');
  kit.clock.set('2026-10-19T16:00:00.000Z');
  await runner.runOnce();
  const lines = warnings(kit, OVERDUE, o.appId);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ deletion_request_id: row.id, status: 'processing' });
  expect(instant(lines[0]!['deadline_at'])).toBe(Date.parse('2026-10-19T16:00:00.000Z'));
});

it('[AC-B1-15f#19] 一轮内同一 app 同一年的日历只读一次，同 app 多张超时单各告一次', async () => {
  configureCalendars();
  const first = await owner(kit.db, { status: 'deleting' });
  const second = await owner(kit.db, { appId: first.appId, status: 'deleting' });
  const r1 = await seedRequest(kit.db, first, {
    status: 'processing',
    applyAt: new Date('2026-09-28T02:00:00.000Z'),
  });
  const r2 = await seedRequest(kit.db, second, {
    status: 'processing',
    applyAt: new Date('2026-09-28T03:00:00.000Z'),
  });
  kit.clock.set('2026-10-23T16:00:00.000Z');
  await kit.runner().runOnce();
  const holidayReads = kit.calendarCalls.filter(
    (c) => c.appId === first.appId && c.key === 'calendar.cn_holidays.2026',
  );
  expect(holidayReads).toHaveLength(1);
  expect(
    warnings(kit, OVERDUE, first.appId)
      .map((line) => line['deletion_request_id'])
      .sort(),
  ).toEqual([r1.id, r2.id].sort());
});
