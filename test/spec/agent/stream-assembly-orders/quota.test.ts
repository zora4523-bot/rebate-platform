// B3-08g · BR-AI-07 判定 4: createOrderNoQuota (stream/mount/orders.ts), the explain_order-by-number
// daily budget per user. +08:00 calendar day, default 20, agent.explain_order.order_no_daily_max when
// it is a positive integer; the counter store is an in-memory stand-in (Redis in production). No
// database.
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createOrderNoQuota,
  orderNoDailyMaxDefault,
  type DailyCounter,
  type OrderNoQuotaDeps,
} from '../../../../apps/api/src/modules/agent/stream/mount/orders.ts';

const MAX_KEY = 'agent.explain_order.order_no_daily_max';
const APP_A = 'synthetic-app-a';
const APP_B = 'synthetic-app-b';
const USER_1 = '0192f3a1-7c00-7000-8000-000000000001';
const USER_2 = '0192f3a1-7c00-7000-8000-000000000002';

function memoryCounter() {
  const counts = new Map<string, number>();
  const incr = vi.fn<DailyCounter['incr']>(async (key) => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
  });
  return { counter: { incr } satisfies DailyCounter, counts, incr };
}

function setup(now: string, config: OrderNoQuotaDeps['config'] = async () => undefined) {
  const clock = new FixedClock(now);
  const memory = memoryCounter();
  const configFn = vi.fn(config);
  const quota = createOrderNoQuota({ counter: memory.counter, clock, config: configFn });
  return { clock, quota, config: configFn, ...memory };
}

async function takes(
  quota: ReturnType<typeof setup>['quota'],
  appId: string,
  userId: string,
  times: number,
): Promise<boolean[]> {
  const out: boolean[] = [];
  for (let i = 0; i < times; i += 1) out.push(await quota.take(appId, userId));
  return out;
}

it('[AC-B3-08g#7][BR-AI-07] 默认每日 20 次：前 20 次 true、第 21 次起 false；键含 appId 与 userId，不同用户、不同 app 互不影响', async () => {
  expect(orderNoDailyMaxDefault()).toBe(20);
  const s = setup('2026-10-23T04:00:00.000Z');
  expect(await takes(s.quota, APP_A, USER_1, 22)).toEqual([
    ...Array.from({ length: 20 }, () => true),
    false,
    false,
  ]);
  // Another user of the same app and the same user in another app each have their own 20.
  expect(await takes(s.quota, APP_A, USER_2, 20)).toEqual(Array.from({ length: 20 }, () => true));
  expect(await takes(s.quota, APP_B, USER_1, 20)).toEqual(Array.from({ length: 20 }, () => true));
  expect(await s.quota.take(APP_A, USER_2)).toBe(false);
  expect(await s.quota.take(APP_B, USER_1)).toBe(false);

  const keys = [...new Set(s.incr.mock.calls.map(([key]) => key))];
  expect(keys).toHaveLength(3);
  const keyOf = (appId: string, userId: string) =>
    keys.filter((key) => key.includes(appId) && key.includes(userId));
  expect(keyOf(APP_A, USER_1)).toHaveLength(1);
  expect(keyOf(APP_A, USER_2)).toHaveLength(1);
  expect(keyOf(APP_B, USER_1)).toHaveLength(1);
  expect(s.config).toHaveBeenCalledWith(APP_A, MAX_KEY);
  expect(s.config).toHaveBeenCalledWith(APP_B, MAX_KEY);
});

it('[AC-B3-08g#8][BR-AI-07] 日界 +08:00：15:59:59Z 与 16:00:00Z 属不同自然日（后者重新计数）；expireAt = 次日 +08:00 零点；同一 +08:00 日内键不变', async () => {
  // 2026-10-22T16:00:00Z is 2026-10-23 00:00 at +08:00: the same day as 2026-10-23T15:59:59Z.
  const s = setup('2026-10-22T16:00:00.000Z');
  expect(await s.quota.take(APP_A, USER_1)).toBe(true);
  s.clock.set('2026-10-23T15:59:59.000Z');
  expect(await takes(s.quota, APP_A, USER_1, 20)).toEqual([
    ...Array.from({ length: 19 }, () => true),
    false,
  ]);
  const firstDay = s.incr.mock.calls.map(([key, expireAt]) => [key, expireAt.toISOString()]);
  expect(new Set(firstDay.map(([key]) => key)).size, 'one key for the +08:00 day').toBe(1);
  for (const [, expireAt] of firstDay) expect(expireAt).toBe('2026-10-23T16:00:00.000Z');

  // 16:00:00Z: 2026-10-24 at +08:00, a fresh count.
  s.clock.set('2026-10-23T16:00:00.000Z');
  const before = s.incr.mock.calls.length;
  expect(await takes(s.quota, APP_A, USER_1, 21)).toEqual([
    ...Array.from({ length: 20 }, () => true),
    false,
  ]);
  const secondDay = s.incr.mock.calls.slice(before);
  expect(new Set(secondDay.map(([key]) => key)).size).toBe(1);
  expect(secondDay[0]![0]).not.toBe(firstDay[0]![0]);
  for (const [, expireAt] of secondDay) {
    expect(expireAt.toISOString()).toBe('2026-10-24T16:00:00.000Z');
  }
});

it('[AC-B3-08g#9][BR-AI-07] order_no_daily_max 为正整数（如 3）即用之', async () => {
  const s = setup('2026-10-23T04:00:00.000Z', async (_appId, key) =>
    key === MAX_KEY ? 3 : undefined,
  );
  expect(await takes(s.quota, APP_A, USER_1, 5)).toEqual([true, true, true, false, false]);
  expect(s.config).toHaveBeenCalledWith(APP_A, MAX_KEY);
});

it.each([
  ['missing', undefined],
  ['null', null],
  ['a string', '3'],
  ['a fraction', 2.5],
  ['zero', 0],
  ['negative', -3],
  ['a boolean', true],
  ['NaN', Number.NaN],
  ['an object', { value: 3 }],
])('[AC-B3-08g#9][BR-AI-07] order_no_daily_max 为 %s → 用默认 20', async (_label, value) => {
  const s = setup('2026-10-23T04:00:00.000Z', async () => value);
  expect(await takes(s.quota, APP_A, USER_1, 21)).toEqual([
    ...Array.from({ length: 20 }, () => true),
    false,
  ]);
});

it('[AC-B3-08g#9][BR-AI-07] order_no_daily_max 读取抛错 → 用默认 20', async () => {
  const s = setup('2026-10-23T04:00:00.000Z', async () => {
    throw new Error('synthetic config failure');
  });
  expect(await takes(s.quota, APP_A, USER_1, 21)).toEqual([
    ...Array.from({ length: 20 }, () => true),
    false,
  ]);
});

it('[AC-B3-08g#9][BR-AI-07] 计数存储抛错 → take 抛错（工具层出 tool_failed），不放行', async () => {
  const clock = new FixedClock('2026-10-23T04:00:00.000Z');
  const incr = vi.fn<DailyCounter['incr']>(async () => {
    throw new Error('synthetic counter failure');
  });
  const quota = createOrderNoQuota({ counter: { incr }, clock, config: async () => 3 });
  await expect(quota.take(APP_A, USER_1)).rejects.toBeTruthy();
  await expect(quota.take(APP_A, USER_1)).rejects.toBeTruthy();
  expect(incr).toHaveBeenCalledTimes(2);
});
