import { expect, it } from 'vitest';
import { ago, HOUR, MINUTE, log, pinned } from './kit.ts';

it.each([
  [1, 30 * MINUTE - 1, false],
  [2, 30 * MINUTE, true],
  [3, 30 * MINUTE + 1, true],
  [4, 72 * HOUR - 1, true],
  [5, 72 * HOUR, true],
  [6, 72 * HOUR + 1, false],
  [7, 25 * HOUR, true],
] as const)('[AC-B1-10h#%s] AC-S1-25② 外跳距今 %s 毫秒 → %s', async (_n, age, expected) => {
  const result = await pinned({ logs: [log({ created_at: ago(age) })] });
  expect(result).toBe(expected);
});

it('[AC-B1-10h#8] AC-S1-25② 无外跳 false；不回退到更早满足时间条件的记录', async () => {
  expect(await pinned({ logs: [] })).toBe(false);
  const older = log({ id: 100n, created_at: ago(2 * HOUR) });
  const recent = log({ id: 2n, created_at: ago(10 * MINUTE), platform: 'pdd' });
  for (const logs of [
    [older, recent],
    [recent, older],
  ]) {
    expect(await pinned({ logs })).toBe(false);
  }
});

it('[AC-B1-10h#9] AC-S1-25② 最新按时间而非id或平台；同一记录随注入时刻改变', async () => {
  const logs = [log({ id: 500n, created_at: ago(71 * HOUR) }), log({ id: 1n })];
  expect(await pinned({ logs })).toBe(true);
  expect(await pinned({ logs, now: ago(31 * MINUTE) })).toBe(false);
  expect(await pinned({ logs, now: ago(-72 * HOUR) })).toBe(false);
});

it.each([
  [10, HOUR + 1, true],
  [11, HOUR, false],
  [12, HOUR - 1, false],
] as const)('[AC-B1-10h#%s] AC-S1-25② 新订单attr_at距今%s毫秒 → %s', async (_n, age, expected) => {
  const result = await pinned({ latest_order_attr_at: ago(age) });
  expect(result).toBe(expected);
});

it('[AC-B1-10h#13] AC-S1-25② 只比较最新有效外跳，旧外跳之后但最新外跳之前的订单不取消置顶', async () => {
  const logs = [log({ id: 2n, created_at: ago(2 * HOUR) }), log()];
  expect(await pinned({ logs, latest_order_attr_at: ago(90 * MINUTE) })).toBe(true);
});
