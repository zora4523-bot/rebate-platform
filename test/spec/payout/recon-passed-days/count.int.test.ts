// B2-07d: the days the daily channel reconciliation (BR-WDR-23) has run through, as the BR-WDR-30
// 开启前置检查 reads them (编排裁定 D10-392: a fact read through the port, never a configuration key;
// D10-408 ②: succeeded counts, 差错 found does not break, partial / failed break; ③ Alipay only).
// Counting goes back from 「昨日」 (+08:00) over app.payout_recon_runs; a missing day breaks; today's
// row is neither counted nor a break. Readings in ./kit.ts.
import { createTestDatabase } from '@couli/db/testing';
import fc from 'fast-check';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createReconPassedDays } from '../../../../apps/api/src/modules/payout/application/recon-passed-days.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  NOW,
  TIMEOUT,
  TODAY,
  YESTERDAY,
  appId,
  close,
  daysBack,
  open,
  passedDays,
  rerun,
  seedRuns,
  succeeded,
  type Harness,
  type RunSeed,
  type RunStatus,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-07d#1] 没有任何对账记录 → 0 天', async () => {
  await expect(passedDays(h, appId())).resolves.toBe(0);
});

it.each([1, 2, 5, 7])('[AC-B2-07d#2] 从昨日起连续 %i 天 succeeded → 同样天数', async (n) => {
  const app = appId();
  await seedRuns(h.app, app, succeeded(daysBack(YESTERDAY, n)));
  await expect(passedDays(h, app)).resolves.toBe(n);
});

it('[AC-B2-07d#3] 连续 40 天 succeeded（跨 9 月 / 10 月月界）→ 40 天', async () => {
  const app = appId();
  const days = daysBack(YESTERDAY, 40);
  expect(days.at(-1)).toBe('2026-09-19');
  await seedRuns(h.app, app, succeeded(days));
  await expect(passedDays(h, app)).resolves.toBe(40);
});

it.each(['partial', 'failed'] as const)(
  '[AC-B2-07d#4] 昨日、前日 succeeded，第 3 天 %s，更早 6 天 succeeded → 只数到它之前：2 天',
  async (status) => {
    const app = appId();
    const days = daysBack(YESTERDAY, 9);
    await seedRuns(h.app, app, [
      ...succeeded(days.slice(0, 2)),
      { billDate: days[2]!, status },
      ...succeeded(days.slice(3)),
    ]);
    await expect(passedDays(h, app)).resolves.toBe(2);
  },
);

it('[AC-B2-07d#5] 第 3 天缺行（那天作业没留下记录）→ 缺天打断：2 天', async () => {
  const app = appId();
  const days = daysBack(YESTERDAY, 9);
  await seedRuns(h.app, app, [...succeeded(days.slice(0, 2)), ...succeeded(days.slice(3))]);
  await expect(passedDays(h, app)).resolves.toBe(2);
});

it.each(['partial', 'failed', 'missing'] as const)(
  '[AC-B2-07d#6] 昨日为 %s、更早 10 天全部 succeeded → 0 天（只从昨日起数）',
  async (yesterday) => {
    const app = appId();
    const days = daysBack(YESTERDAY, 11);
    const first: RunSeed[] =
      yesterday === 'missing' ? [] : [{ billDate: YESTERDAY, status: yesterday }];
    await seedRuns(h.app, app, [...first, ...succeeded(days.slice(1))]);
    await expect(passedDays(h, app)).resolves.toBe(0);
  },
);

it('[AC-B2-07d#7] 发现差错不打断（D10-408 ②）：连续 5 天 succeeded、其中 3 天 diffs > 0 → 5 天', async () => {
  const app = appId();
  const days = daysBack(YESTERDAY, 5);
  await seedRuns(h.app, app, [
    { billDate: days[0]!, status: 'succeeded', diffs: 2 },
    { billDate: days[1]!, status: 'succeeded', diffs: 0 },
    { billDate: days[2]!, status: 'succeeded', diffs: 1 },
    { billDate: days[3]!, status: 'succeeded', diffs: 0 },
    { billDate: days[4]!, status: 'succeeded', diffs: 7 },
  ]);
  await expect(passedDays(h, app)).resolves.toBe(5);
});

it('[AC-B2-07d#8] 每天都发现差错（diffs > 0）的 succeeded 也照计：3 天', async () => {
  const app = appId();
  await seedRuns(h.app, app, succeeded(daysBack(YESTERDAY, 3), 4));
  await expect(passedDays(h, app)).resolves.toBe(3);
});

it.each(['succeeded', 'partial', 'failed'] as const)(
  '[AC-B2-07d#9] 今天（%s）的行不计也不打断：今天有行、昨日起 3 天 succeeded → 3 天',
  async (today) => {
    const app = appId();
    await seedRuns(h.app, app, [
      { billDate: TODAY, status: today },
      ...succeeded(daysBack(YESTERDAY, 3)),
    ]);
    await expect(passedDays(h, app)).resolves.toBe(3);
  },
);

it('[AC-B2-07d#10] 只有今天的 succeeded 行 → 0 天（还没到 T+1）', async () => {
  const app = appId();
  await seedRuns(h.app, app, [{ billDate: TODAY, status: 'succeeded' }]);
  await expect(passedDays(h, app)).resolves.toBe(0);
});

it('[AC-B2-07d#11] 别的 app 不串：别 app 的 succeeded 不算、不补本 app 的缺天，别 app 的 failed 不打断本 app', async () => {
  const mine = appId();
  const other = appId();
  const third = appId();
  const days = daysBack(YESTERDAY, 10);
  await seedRuns(h.app, other, succeeded(days));
  await expect(passedDays(h, mine)).resolves.toBe(0);
  await expect(passedDays(h, other)).resolves.toBe(10);

  // mine: yesterday and the day before, then a gap that other's succeeded row must not fill.
  await seedRuns(h.app, mine, [...succeeded(days.slice(0, 2)), ...succeeded(days.slice(3))]);
  await expect(passedDays(h, mine)).resolves.toBe(2);

  // third fails on a day mine succeeded: mine keeps its count, third stops at it.
  await seedRuns(h.app, third, [
    ...succeeded([days[0]!]),
    { billDate: days[1]!, status: 'failed' },
  ]);
  await expect(passedDays(h, third)).resolves.toBe(1);
  await expect(passedDays(h, mine)).resolves.toBe(2);
  await expect(passedDays(h, other)).resolves.toBe(10);
});

it.each([
  // 2026-10-28 23:59:59.999 +08:00: today is 10-28, 「昨日」 10-27 → only 10-27 (10-26 missing).
  { now: '2026-10-28T15:59:59.999Z', days: 1 },
  // 2026-10-29 00:00 +08:00 (UTC still 10-28): 「昨日」 is 10-28 → 10-28 and 10-27.
  { now: '2026-10-28T16:00:00.000Z', days: 2 },
  // 2026-10-29 04:00 +08:00 (UTC 10-28 20:00).
  { now: '2026-10-28T20:00:00.000Z', days: 2 },
  // 2026-10-29 23:59:59.999 +08:00.
  { now: '2026-10-29T15:59:59.999Z', days: 2 },
  // 2026-10-30 00:00 +08:00: 「昨日」 10-29 has no row → 0.
  { now: '2026-10-29T16:00:00.000Z', days: 0 },
])(
  '[AC-B2-07d#12] 日界按 +08:00：10-27、10-28 两天 succeeded，时钟 $now → $days 天',
  async ({ now, days }) => {
    const app = appId();
    await seedRuns(h.app, app, succeeded(['2026-10-28', '2026-10-27']));
    await expect(passedDays(h, app, now)).resolves.toBe(days);
  },
);

it('[AC-B2-07d#13] 每次调用按当时的时钟与当时的库：重跑改为 succeeded、时钟前进一天、补上一天都立刻反映', async () => {
  const app = appId();
  const clock = new FixedClock(NOW);
  const port = createReconPassedDays({ clock });
  const days = daysBack(YESTERDAY, 4);
  await seedRuns(h.app, app, [
    ...succeeded(days.slice(0, 2)),
    { billDate: days[2]!, status: 'failed' },
    ...succeeded(days.slice(3)),
  ]);
  await expect(port.passedDays(app, h.reader)).resolves.toBe(2);

  // The failed day is run again and now succeeds: the row is overwritten.
  await rerun(h.app, app, days[2]!, 'succeeded');
  await expect(port.passedDays(app, h.reader)).resolves.toBe(4);

  // The next day: 10-29 becomes 「昨日」 and has no row yet.
  clock.advanceMs(86_400_000);
  await expect(port.passedDays(app, h.reader)).resolves.toBe(0);
  await seedRuns(h.app, app, [{ billDate: TODAY, status: 'succeeded', diffs: 1 }]);
  await expect(port.passedDays(app, h.reader)).resolves.toBe(5);

  // A rerun of 10-28 that ends partial breaks the run again.
  await rerun(h.app, app, YESTERDAY, 'partial');
  await expect(port.passedDays(app, h.reader)).resolves.toBe(1);
});

const DAY_STATES = ['succeeded', 'succeeded_diff', 'partial', 'failed', 'missing'] as const;
type DayState = (typeof DAY_STATES)[number];

function seedOf(billDate: string, state: DayState): RunSeed | null {
  if (state === 'missing') return null;
  if (state === 'succeeded_diff') return { billDate, status: 'succeeded', diffs: 3 };
  const status: RunStatus = state;
  return { billDate, status };
}

it(
  '[AC-B2-07d#14] 性质：昨日起任意至多 25 天的状态（另含今天的行）→ 结果等于从昨日起连续 succeeded 的天数',
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...DAY_STATES), { maxLength: 25 }),
        fc.constantFrom(...DAY_STATES),
        async (states, today) => {
          const app = appId();
          const days = daysBack(YESTERDAY, states.length);
          const seeds: RunSeed[] = [];
          states.forEach((state, i) => {
            const seed = seedOf(days[i]!, state);
            if (seed !== null) seeds.push(seed);
          });
          const todaySeed = seedOf(TODAY, today);
          if (todaySeed !== null) seeds.push(todaySeed);
          await seedRuns(h.app, app, seeds);
          const firstBreak = states.findIndex(
            (state) => state !== 'succeeded' && state !== 'succeeded_diff',
          );
          const answer = await passedDays(h, app);
          expect(Number.isInteger(answer) && answer >= 0).toBe(true);
          expect(answer).toBe(firstBreak === -1 ? states.length : firstBreak);
        },
      ),
      { numRuns: 30 },
    );
  },
  5 * TIMEOUT,
);
