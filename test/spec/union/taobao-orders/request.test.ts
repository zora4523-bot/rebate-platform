import { afterEach, expect, it, vi } from 'vitest';
import type { OrderTimeBasis } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  collect,
  ctx,
  DATAOKE_BASE,
  listed,
  onePage,
  ORDER_PATH,
  ORDER_VERSION,
  rejection,
  setup,
  win,
} from './kit.ts';

// 请求口径（任务书「目标口径 · 请求」）：GET get-order-details v1.0.0；queryType 由 timeBasis 定、默认 4；
// startTime / endTime 是北京时间文本，由 TimeWindow 换算、与注入时钟无关；pageSize 100、orderScene 1。

afterEach(() => {
  vi.unstubAllEnvs();
});

it('[AC-B1-04f#1] 首页：GET 大淘客 get-order-details（v1.0.0），queryType 默认 4、pageSize 100、orderScene 1、不带 positionIndex；不碰淘宝 TOP 网关', async () => {
  const s = setup(onePage([]));
  await collect(s.adapter);
  expect(s.transport).toHaveBeenCalledTimes(1);
  const request = s.transport.mock.calls[0]![0];
  expect(request.method).toBe('GET');
  const url = new URL(request.url);
  expect(`${url.origin}${url.pathname}`).toBe(`${DATAOKE_BASE}${ORDER_PATH}`);
  expect(s.requests[0]).toMatchObject({
    version: ORDER_VERSION,
    queryType: '4',
    pageSize: '100',
    orderScene: '1',
    startTime: '2026-10-30 10:00:00',
    endTime: '2026-10-30 11:00:00',
  });
  expect(s.requests[0]).not.toHaveProperty('positionIndex');
  expect(s.dataokeCredentials).toHaveBeenCalledTimes(1);
  expect(s.taobaoTransport).not.toHaveBeenCalled();
  expect(s.taobaoCredentials).not.toHaveBeenCalled();
});

it.each([
  ['update', '4'],
  ['pay', '2'],
  ['settle', '3'],
  ['create', '1'],
] as const)('[AC-B1-04f#2] timeBasis=%s → queryType %s', async (timeBasis, queryType) => {
  const s = setup(onePage([]));
  await collect(s.adapter, win, { timeBasis });
  expect(s.requests).toHaveLength(1);
  expect(s.requests[0]).toMatchObject({ queryType, pageSize: '100', orderScene: '1' });
});

it.each(['paid', 'UPDATE', '4', ''])(
  '[AC-B1-04f#3] 未知 timeBasis「%s」→ invalid_dto，不取凭据、不发请求',
  async (timeBasis) => {
    const s = setup(onePage([]));
    await rejection(
      () => s.adapter.listOrders(win, { timeBasis: timeBasis as unknown as OrderTimeBasis }, ctx),
      'invalid_dto',
    );
    expect(s.transport).not.toHaveBeenCalled();
    expect(s.dataokeCredentials).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04f#4] 非整秒窗口向外取整到秒（from 向下、to 向上），文本是北京时间', async () => {
  const s = setup(onePage([]));
  await collect(s.adapter, { from: '2026-10-30T02:00:00.123Z', to: '2026-10-30T02:30:00.456Z' });
  expect(s.requests[0]).toMatchObject({
    startTime: '2026-10-30 10:00:00',
    endTime: '2026-10-30 10:30:01',
  });
});

it('[AC-B1-04f#5] 跨北京时间零点按 UTC+8 落到次日', async () => {
  const s = setup(onePage([]));
  await collect(s.adapter, { from: '2026-10-29T15:30:00Z', to: '2026-10-29T16:30:00Z' });
  expect(s.requests[0]).toMatchObject({
    startTime: '2026-10-29 23:30:00',
    endTime: '2026-10-30 00:30:00',
  });
});

it.each(['UTC', 'America/New_York', 'Asia/Shanghai', 'Asia/Tokyo'])(
  '[AC-B1-04f#6] 进程时区 %s 下，发给上游的文本仍是北京时间',
  async (zone) => {
    vi.stubEnv('TZ', zone);
    const s = setup(onePage([]));
    await collect(s.adapter);
    expect(s.requests[0]).toMatchObject({
      startTime: '2026-10-30 10:00:00',
      endTime: '2026-10-30 11:00:00',
    });
  },
);

it('[AC-B1-04f#7] 窗口文本只由 TimeWindow 换算：注入时钟前进 30 天，同一窗口发出同样的文本', async () => {
  const s = setup(onePage([]));
  await collect(s.adapter);
  s.clock.advanceMs(30 * 86_400_000);
  await collect(s.adapter);
  expect(s.requests).toHaveLength(2);
  expect(s.requests[1]!.startTime).toBe(s.requests[0]!.startTime);
  expect(s.requests[1]!.endTime).toBe(s.requests[0]!.endTime);
  expect(s.requests[0]).toMatchObject({ startTime: '2026-10-30 10:00:00' });
});

it.each([
  ['相等', { from: win.from, to: win.from }],
  ['逆序', { from: win.to, to: win.from }],
  ['同秒内逆序', { from: '2026-10-30T02:00:00.501Z', to: '2026-10-30T02:00:00.500Z' }],
  ['起点不是时刻', { from: 'not-a-time', to: win.to }],
  ['终点不是时刻', { from: win.from, to: 'not-a-time' }],
] as const)('[AC-B1-04f#8] 时间窗%s → invalid_dto，不取凭据、不发请求', async (_name, window) => {
  const s = setup(onePage([]));
  await rejection(() => s.adapter.listOrders(window, {}, ctx), 'invalid_dto');
  expect(s.transport).not.toHaveBeenCalled();
  expect(s.dataokeCredentials).not.toHaveBeenCalled();
  expect(s.taobaoCredentials).not.toHaveBeenCalled();
});

it('[AC-B1-04f#9] 归档上下文是调用方 app 与 kind=order；直接调用（无 gateUpstream）把 ctx.signal 挂在传输请求上', async () => {
  const controller = new AbortController();
  const s = setup(onePage([]));
  await listed(s.adapter.listOrders(win, {}, { ...ctx, signal: controller.signal }));
  expect(s.transport).toHaveBeenCalledTimes(1);
  const request = s.transport.mock.calls[0]![0];
  expect(request.archive).toEqual({ appId: ctx.appId, kind: 'order' });
  expect(request.signal).toBe(controller.signal);
});
