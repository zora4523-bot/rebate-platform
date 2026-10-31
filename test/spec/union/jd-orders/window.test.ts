import { afterEach, expect, it, vi } from 'vitest';
import { beijingMs, collect, ctx, dayMs, hourMs, nowMs, pageAnswer, win, wire } from './kit.ts';

// 时间窗按毫秒原值判，拆窗是 order-sync 的事：适配器只校验，不合格不取凭据、不发请求。
const oldestMs = nowMs - 90 * dayMs;
const iso = (ms: number): string => new Date(ms).toISOString();

afterEach(() => {
  vi.unstubAllEnvs();
});

it.each([
  ['完整 1 小时', nowMs - hourMs, nowMs],
  ['不足 1 小时但外扩成 3601 秒', nowMs - hourMs + 100, nowMs - 100],
  ['恰好 90 天且完整 1 小时', oldestMs, oldestMs + hourMs],
  ['90 天界内一毫秒', oldestMs + 1, oldestMs + 60_000],
] as const)(
  '[AC-B1-04zb#1] %s 按毫秒接受，发给上游的整秒边界不越 1 小时与 90 天',
  async (_name, fromMs, toMs) => {
    const { adapter, clock, requests } = wire(pageAnswer([[]]));
    clock.advanceMs(500);
    const shifted = { from: fromMs + 500, to: toMs + 500 };
    const window = { from: iso(shifted.from), to: iso(shifted.to) };
    await expect(adapter.listOrders(window, {}, ctx)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(requests).toHaveLength(1);
    const start = beijingMs(requests[0]!.startTime);
    const end = beijingMs(requests[0]!.endTime);
    expect(end).toBeGreaterThan(start);
    expect(end - start).toBeLessThanOrEqual(hourMs);
    expect(start).toBeGreaterThanOrEqual(oldestMs + 500);
    // Only the subsecond rounding may move a bound, never by more than the rounding itself.
    expect(start).toBeGreaterThanOrEqual(Math.floor(shifted.from / 1000) * 1000);
    expect(start).toBeLessThanOrEqual(Math.ceil(shifted.from / 1000) * 1000);
    expect(end).toBeGreaterThanOrEqual(Math.floor(shifted.to / 1000) * 1000);
    expect(end).toBeLessThanOrEqual(Math.ceil(shifted.to / 1000) * 1000);
  },
);

it('[AC-B1-04zb#2] 普通窗口向外取整到秒：from 向下、to 向上，文本是 GMT+8', async () => {
  const { adapter, requests } = wire(pageAnswer([[]]));
  await collect(adapter, { from: '2026-10-30T02:00:00.123Z', to: '2026-10-30T02:30:00.456Z' });
  expect(requests[0]).toMatchObject({
    startTime: '2026-10-30 10:00:00',
    endTime: '2026-10-30 10:30:01',
  });
});

it('[AC-B1-04zb#3] 整秒窗口原样发送；跨北京时间零点按 GMT+8 落到次日', async () => {
  const { adapter, requests } = wire(pageAnswer([[]]));
  await collect(adapter, win);
  await collect(adapter, { from: '2026-10-29T15:30:00Z', to: '2026-10-29T16:30:00Z' });
  expect(requests[0]).toMatchObject({
    startTime: '2026-10-30 10:00:00',
    endTime: '2026-10-30 11:00:00',
  });
  expect(requests[1]).toMatchObject({
    startTime: '2026-10-29 23:30:00',
    endTime: '2026-10-30 00:30:00',
  });
});

it.each([
  ['跨度多 1 毫秒', { from: iso(nowMs - hourMs - 1), to: iso(nowMs) }],
  ['跨度 2 小时', { from: '2026-10-30T02:00:00Z', to: '2026-10-30T04:00:00Z' }],
  ['早于 90 天 1 毫秒', { from: iso(oldestMs - 1), to: iso(oldestMs + 60_000) }],
  ['相等', { from: win.from, to: win.from }],
  ['逆序', { from: win.to, to: win.from }],
  ['同秒内相等', { from: '2026-10-30T02:00:00.500Z', to: '2026-10-30T02:00:00.500Z' }],
  ['同秒内逆序', { from: '2026-10-30T02:00:00.501Z', to: '2026-10-30T02:00:00.500Z' }],
  ['起点不是时刻', { from: 'not-a-time', to: win.to }],
  ['终点不是时刻', { from: win.from, to: 'not-a-time' }],
] as const)('[AC-B1-04zb#4] %s → invalid_dto，不取凭据、不发请求', async (_name, window) => {
  const { adapter, credentials, transport } = wire(pageAnswer([[]]));
  await expect(adapter.listOrders(window, {}, ctx)).rejects.toMatchObject({
    code: 'invalid_dto',
    platform: 'jd',
  });
  expect(credentials).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it('[AC-B1-04zb#5] 同秒内相邻两毫秒是合法窗口，不被取整或按秒比较挡掉', async () => {
  const { adapter, requests } = wire(pageAnswer([[]]));
  await expect(
    adapter.listOrders(
      { from: '2026-10-30T02:00:00.500Z', to: '2026-10-30T02:00:00.501Z' },
      {},
      ctx,
    ),
  ).resolves.toEqual({ items: [], nextCursor: null });
  expect(requests[0]).toMatchObject({
    startTime: '2026-10-30 10:00:00',
    endTime: '2026-10-30 10:00:01',
  });
});

it('[AC-B1-04zb#6] 90 天界看注入时钟：恰好 90 天可查，时钟前进一毫秒即过期', async () => {
  const { adapter, clock, transport } = wire(pageAnswer([[]]));
  const window = { from: iso(oldestMs), to: iso(oldestMs + hourMs) };
  await expect(adapter.listOrders(window, {}, ctx)).resolves.toHaveProperty('items');
  expect(transport).toHaveBeenCalledTimes(1);
  clock.advanceMs(1);
  await expect(adapter.listOrders(window, {}, ctx)).rejects.toMatchObject({ code: 'invalid_dto' });
  expect(transport).toHaveBeenCalledTimes(1);
});

it.each(['UTC', 'America/New_York', 'Asia/Shanghai', 'Asia/Tokyo'])(
  '[AC-B1-04zb#7] 进程时区 %s 下，发给上游的文本仍是 GMT+8',
  async (zone) => {
    vi.stubEnv('TZ', zone);
    const { adapter, requests } = wire(pageAnswer([[]]));
    await collect(adapter);
    expect(requests[0]).toMatchObject({
      startTime: '2026-10-30 10:00:00',
      endTime: '2026-10-30 11:00:00',
    });
  },
);
