// B1-22b: the pure day arithmetic of the site authorization check (task §9 判定口径).
import { expect, it } from 'vitest';
import {
  DEFAULT_PROBE_TIME,
  dueNode,
  nextCheckSlot,
  parseAlertDays,
  parseProbeCron,
  reachedNode,
  remainingDays,
  statusFor,
} from './schedule.ts';

const ms = (iso: string): number => Date.parse(iso);

it('[BR-ID-24] 节点取 1–999 去重降序，任一不合法整组无效；巡检只认每日 m h * * *', () => {
  expect(parseAlertDays([30, 7, 30, 1])).toEqual([30, 7, 1]);
  for (const bad of [null, [], [0], [1000], [1.5], ['7'], '14,7,1', [14, 0]]) {
    expect(parseAlertDays(bad)).toBeNull();
  }
  expect(parseProbeCron('15 10 * * *')).toEqual({ hour: 10, minute: 15 });
  for (const bad of [null, '*/5 * * * *', '0 24 * * *', '60 9 * * *', '0 9 * * 1']) {
    expect(parseProbeCron(bad)).toBeNull();
  }
});

it('[BR-ID-24] 剩余天数按最近巡检时刻所在 +08 日期计，含闰日', () => {
  const expires = ms('2026-12-29T16:00:00Z');
  expect(remainingDays(expires, ms('2026-12-16T00:59:00Z'), DEFAULT_PROBE_TIME)).toBe(15);
  expect(remainingDays(expires, ms('2026-12-16T01:00:00Z'), DEFAULT_PROBE_TIME)).toBe(14);
  const leap = ms('2028-02-29T16:00:00Z');
  const at1015 = { hour: 10, minute: 15 };
  expect(remainingDays(leap, ms('2028-02-29T02:14:59.999Z'), at1015)).toBe(2);
  expect(remainingDays(leap, ms('2028-02-29T02:15:00Z'), at1015)).toBe(1);
});

it('[BR-ID-24] 下一巡检时刻严格晚于当前，标签为 +08 分钟', () => {
  const at1015 = { hour: 10, minute: 15 };
  expect(nextCheckSlot(ms('2026-12-16T01:00:00Z'), at1015)).toEqual({
    dueMs: ms('2026-12-16T02:15:00Z'),
    label: '2026-12-16T10:15',
  });
  expect(nextCheckSlot(ms('2026-12-16T02:15:00Z'), at1015)).toEqual({
    dueMs: ms('2026-12-17T02:15:00Z'),
    label: '2026-12-17T10:15',
  });
  expect(nextCheckSlot(ms('2028-02-28T16:00:00Z'), DEFAULT_PROBE_TIME).label).toBe(
    '2028-02-29T09:00',
  );
});

it('[BR-ID-24] 只提醒已到达的最小节点，跳过的不补、已发的不倒退', () => {
  const nodes = [14, 7, 1];
  expect(dueNode(15, nodes, 'none')).toBeNull();
  expect(dueNode(14, nodes, 'none')).toBe(14);
  expect(dueNode(5, nodes, 'none')).toBe(7);
  expect(dueNode(5, nodes, 'd7')).toBeNull();
  expect(dueNode(1, nodes, 'd7')).toBe(1);
  expect(dueNode(14, [30, 14, 7, 1], 'd7')).toBeNull();
  expect(dueNode(1, nodes, 'expired')).toBeNull();
  expect(reachedNode(4, nodes)).toBe(7);
  expect(statusFor(14, nodes)).toBe('expiring');
  expect(statusFor(15, nodes)).toBe('active');
});
