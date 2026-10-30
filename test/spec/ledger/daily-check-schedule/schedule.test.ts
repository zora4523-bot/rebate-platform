// B2-02q: the queue of the daily ledger check and the calendar of its chain (08 BR-FUND-19 每日
// 01:00 +08:00 对会计日 D−1 运行; task brief: queue ledger-check, job daily, singletonKey
// `daily:<app_id>:<D>`, exclusive like payout-recon / pay; the run of D due at D+1 01:00 +08:00 and
// at once when that has passed). Unit tests: no database, no port. Top-level it() only (规划/11 §4.3).
import { accountingDate, chinaDayRange } from '@couli/domain';
import { expect, it } from 'vitest';
import {
  dailyCheckDayAfter,
  dailyCheckDayOf,
  dailyCheckJobKey,
  dailyCheckRunAtMs,
  scheduleDailyCheck,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  ENTRY_PLAN,
  QUEUE_CATALOG,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import {
  APP,
  DAY,
  NEXT_DAY,
  NEXT_RUN_AT,
  QUEUE,
  RUN_AT,
  expectedSend,
  fakeQueue,
  keyOf,
  sendView,
} from './kit.ts';

const DEFAULT = {
  retryLimit: 5,
  retryDelaySeconds: 10,
  retryBackoff: true,
  retryDelayMaxSeconds: 600,
  expireInSeconds: 900,
  retentionSeconds: 1_209_600,
  deleteAfterSeconds: 604_800,
} as const;

/** An instant as a Date (parsed from ISO text; the tests never read a clock). */
function at(iso: string): Date {
  return new Date(Date.parse(iso));
}

/** The message a call throws ('returned' when it does not). */
function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'returned';
}

it('[AC-B2-02q#1] 队列目录：ledger-check 恰一条，exclusive（按 singletonKey 去重）、目录默认值、死信 ledger-check.dead，紧跟 payout-recon；死信队列设置同其他 <q>.dead', () => {
  expect(QUEUE_CATALOG.filter((queue) => queue.name === QUEUE)).toStrictEqual([
    { name: QUEUE, policy: 'exclusive', ...DEFAULT, deadLetter: 'ledger-check.dead' },
  ]);
  const position = QUEUE_CATALOG.findIndex((queue) => queue.name === QUEUE);
  expect(QUEUE_CATALOG[position - 1]?.name).toBe('payout-recon');
  expect(QUEUE_CATALOG.filter((queue) => queue.name === 'ledger-check.dead')).toStrictEqual([
    {
      name: 'ledger-check.dead',
      policy: 'standard',
      retryLimit: 0,
      retryDelaySeconds: 1,
      retryBackoff: false,
      retryDelayMaxSeconds: null,
      expireInSeconds: 900,
      retentionSeconds: 2_592_000,
      deleteAfterSeconds: 2_592_000,
      deadLetter: null,
    },
  ]);
});

it('[AC-B2-02q#2] 入口计划：只有 worker 消费 ledger-check，并发 1、轮询 2 秒，紧跟 payout-recon；api / stream / admin / payout 都不消费', () => {
  expect(ENTRY_PLAN.worker.filter((work) => work.queue === QUEUE)).toStrictEqual([
    { queue: QUEUE, concurrency: 1, pollingIntervalSeconds: 2 },
  ]);
  const position = ENTRY_PLAN.worker.findIndex((work) => work.queue === QUEUE);
  expect(ENTRY_PLAN.worker[position - 1]?.queue).toBe('payout-recon');
  expect(
    (['api', 'stream', 'admin', 'payout'] as const).flatMap((entry) =>
      ENTRY_PLAN[entry].filter((work) => work.queue === QUEUE).map(() => entry),
    ),
  ).toStrictEqual([]);
});

it('[AC-B2-02q#3] singletonKey 按 app 与 D：daily:<app_id>:<D>；不同 app 或不同 D 各不相同；只用队列允许的字符', () => {
  const keys = [
    dailyCheckJobKey(APP, DAY),
    dailyCheckJobKey(APP, NEXT_DAY),
    dailyCheckJobKey('dcs-app-b', DAY),
  ];
  expect(keys).toStrictEqual([
    'daily:dcs-app-a:2032-06-15',
    'daily:dcs-app-a:2032-06-16',
    'daily:dcs-app-b:2032-06-15',
  ]);
  expect(keys).toStrictEqual([keyOf(APP, DAY), keyOf(APP, NEXT_DAY), keyOf('dcs-app-b', DAY)]);
  // contract section 3 of platform/queue: [A-Za-z0-9:._+-], at most 200 characters.
  for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9:._+-]{1,200}$/u);
});

it('[AC-B2-02q#4] D 的运行时刻 = D+1 01:00 +08:00（月末、年末、闰日照样）；D 的下一天按 +08:00 日历', () => {
  const runs: Record<string, string> = {
    '2032-06-15': '2032-06-15T17:00:00.000Z',
    '2032-06-30': '2032-06-30T17:00:00.000Z',
    '2032-12-31': '2032-12-31T17:00:00.000Z',
    '2032-02-28': '2032-02-28T17:00:00.000Z',
    '2032-02-29': '2032-02-29T17:00:00.000Z',
    '2031-02-28': '2031-02-28T17:00:00.000Z',
  };
  expect(
    Object.fromEntries(
      Object.keys(runs).map((day) => [day, new Date(dailyCheckRunAtMs(day)).toISOString()]),
    ),
  ).toStrictEqual(runs);
  expect(dailyCheckRunAtMs(DAY)).toBe(Date.parse(RUN_AT));
  expect(dailyCheckRunAtMs(NEXT_DAY)).toBe(Date.parse(NEXT_RUN_AT));
  const after: Record<string, string> = {
    '2032-06-15': '2032-06-16',
    '2032-06-30': '2032-07-01',
    '2032-12-31': '2033-01-01',
    '2032-02-28': '2032-02-29',
    '2032-02-29': '2032-03-01',
    '2031-02-28': '2031-03-01',
  };
  expect(
    Object.fromEntries(Object.keys(after).map((day) => [day, dailyCheckDayAfter(day)])),
  ).toStrictEqual(after);
});

it('[AC-B2-02q#5] 触发时刻所在 +08:00 日的前一天就是 D：00:00 / 00:59 / 01:00 / 23:59 +08:00 都给 D−1，跨 UTC 零点不受影响；D 的运行时刻落在当天 01:00', () => {
  const cases: Record<string, string> = {
    // 2032-06-16 00:00:00.000 +08:00
    '2032-06-15T16:00:00.000Z': '2032-06-15',
    // 2032-06-16 00:59:59.999 +08:00
    '2032-06-15T16:59:59.999Z': '2032-06-15',
    // 2032-06-16 01:00 +08:00
    '2032-06-15T17:00:00.000Z': '2032-06-15',
    // 2032-06-16 08:00 +08:00 (UTC midnight)
    '2032-06-16T00:00:00.000Z': '2032-06-15',
    // 2032-06-16 23:59:59.999 +08:00
    '2032-06-16T15:59:59.999Z': '2032-06-15',
    // 2032-06-15 23:59:59.999 +08:00
    '2032-06-15T15:59:59.999Z': '2032-06-14',
    // 2033-01-01 00:30 +08:00
    '2032-12-31T16:30:00.000Z': '2032-12-31',
    // 2032-03-01 12:00 +08:00
    '2032-03-01T04:00:00.000Z': '2032-02-29',
  };
  expect(
    Object.fromEntries(Object.keys(cases).map((iso) => [iso, dailyCheckDayOf(at(iso))])),
  ).toStrictEqual(cases);
  for (const iso of Object.keys(cases)) {
    const day = dailyCheckDayOf(at(iso));
    // The run of that D is 01:00 +08:00 of the day `iso` is in.
    const today = chinaDayRange(accountingDate(at(iso))).start;
    expect(dailyCheckRunAtMs(day), iso).toBe(Date.parse(today) + 3_600_000);
  }
});

it('[AC-B2-02q#6] 不存在或格式不对的 D 被拒绝（不算出一个时刻或日期）', () => {
  for (const day of ['2032-02-30', '2031-02-29', '2032-6-15', '2032/06/15', '']) {
    for (const call of [() => dailyCheckRunAtMs(day), () => dailyCheckDayAfter(day)]) {
      const message = thrownMessage(call);
      expect(message, day).not.toBe('returned');
      expect(message, day).not.toMatch(/NotImplemented/u);
    }
  }
});

it('[AC-B2-02q#7] scheduleDailyCheck：送 ledger-check / daily，负载 { app_id, accounting_date }，singletonKey daily:<app>:<D>，延迟到 D+1 01:00（不足 1 秒按 1 秒，已过则 0）；事务原样交给队列，返回队列的结果', async () => {
  const queue = fakeQueue();
  const trx = { isTransaction: true } as never;
  const ids = [
    // 2032-06-15 12:00 +08:00: 13 hours before the run.
    await scheduleDailyCheck(queue, null, APP, DAY, at('2032-06-15T04:00:00.000Z')),
    // 2032-06-16 00:30 +08:00: half an hour before.
    await scheduleDailyCheck(queue, trx, APP, DAY, at('2032-06-15T16:30:00.000Z')),
    // 1.5 seconds before: rounded up, never early.
    await scheduleDailyCheck(queue, null, APP, DAY, at('2032-06-15T16:59:58.500Z')),
    // At the run time and a day late: at once.
    await scheduleDailyCheck(queue, null, APP, DAY, at(RUN_AT)),
    await scheduleDailyCheck(queue, trx, APP, DAY, at(NEXT_RUN_AT)),
  ];
  expect(queue.sent.map(sendView)).toStrictEqual([
    expectedSend(APP, DAY, 46_800),
    expectedSend(APP, DAY, 1_800),
    expectedSend(APP, DAY, 2),
    expectedSend(APP, DAY, 0),
    expectedSend(APP, DAY, 0),
  ]);
  expect(queue.sent.map((job) => job.options.trx === null)).toStrictEqual([
    true,
    false,
    true,
    true,
    false,
  ]);
  expect(queue.sent.map((job) => job.inTransaction)).toStrictEqual([
    false,
    true,
    false,
    false,
    true,
  ]);
  expect(ids.every((id) => typeof id === 'string' && id !== '')).toBe(true);
});
