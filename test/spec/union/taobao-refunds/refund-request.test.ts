import { afterEach, expect, it, vi } from 'vitest';
import type {
  RefundTimeBasis,
  TimeWindow,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  ctx,
  DATAOKE_BASE,
  hourMs,
  iso,
  listed,
  REFUND_PATH,
  refundOf,
  refundPage,
  refunds,
  rejection,
  setup,
  VERSION,
  win,
} from './kit.ts';

// 维权请求口径（任务书「目标口径 · listRefunds」，编排 10-31 17:2x 更正）：GET（不是文档写的 POST）
// /api/tb-service/get-order-refund v1.0.0；queryType 默认 5（订单更新），可经 RefundQueryOpt.timeBasis
// 选 1–5；startTime / endTime 是北京时间文本、由 TimeWindow 换算；pageSize 100、memberType 4、
// orderScene 1。queryType 4 / 5 的起点不得早于北京时间 2022-12-20。维权记录没有推广位字段，不读推广位。

afterEach(() => {
  vi.unstubAllEnvs();
});

it('[AC-B1-04z#1] 首页：GET 大淘客 get-order-refund（v1.0.0），queryType 默认 5、pageSize 100、memberType 4、orderScene 1、不带 positionIndex；不碰淘宝 TOP 网关', async () => {
  const s = setup(refundPage([]));
  await refunds(s.adapter);
  expect(s.transport).toHaveBeenCalledTimes(1);
  const call = s.calls[0]!;
  expect(call.method).toBe('GET');
  expect(call.request.body).toBeUndefined();
  const url = new URL(call.request.url);
  expect(`${url.origin}${url.pathname}`).toBe(`${DATAOKE_BASE}${REFUND_PATH}`);
  expect(call.query).toMatchObject({
    version: VERSION,
    queryType: '5',
    pageSize: '100',
    memberType: '4',
    orderScene: '1',
    startTime: '2026-10-30 10:00:00',
    endTime: '2026-10-30 11:00:00',
  });
  expect(call.query).not.toHaveProperty('positionIndex');
  expect(s.dataokeCredentials).toHaveBeenCalledTimes(1);
  expect(s.taobaoTransport).not.toHaveBeenCalled();
  expect(s.taobaoCredentials).not.toHaveBeenCalled();
});

it.each([
  ['refund_created', '1'],
  ['settle', '2'],
  ['refund_finished', '3'],
  ['create', '4'],
  ['update', '5'],
] as const)('[AC-B1-04z#2] timeBasis=%s → queryType %s', async (timeBasis, queryType) => {
  const s = setup(refundPage([]));
  await refunds(s.adapter, win, { timeBasis });
  expect(s.requests).toHaveLength(1);
  expect(s.requests[0]).toMatchObject({
    queryType,
    pageSize: '100',
    memberType: '4',
    orderScene: '1',
  });
});

it.each(['refund', 'UPDATE', '5', '', 'pay'])(
  '[AC-B1-04z#3] 未知 timeBasis「%s」→ invalid_dto，不取凭据、不发请求',
  async (timeBasis) => {
    const s = setup(refundPage([]));
    await rejection(
      () => s.adapter.listRefunds(win, ctx, { timeBasis: timeBasis as unknown as RefundTimeBasis }),
      'invalid_dto',
    );
    expect(s.transport).not.toHaveBeenCalled();
    expect(s.dataokeCredentials).not.toHaveBeenCalled();
  },
);

// 北京时间 2022-12-20 00:00:00 = 2022-12-19T16:00:00Z。
const cutoffMs = Date.parse('2022-12-19T16:00:00Z');
const atCutoff: TimeWindow = { from: iso(cutoffMs), to: iso(cutoffMs + hourMs) };
const beforeCutoff: TimeWindow = { from: iso(cutoffMs - 1000), to: iso(cutoffMs + hourMs) };

it.each(['create', 'update', undefined] as const)(
  '[AC-B1-04z#4] queryType 4 / 5（timeBasis=%s）起点早于北京时间 2022-12-20 → invalid_dto，不发请求；恰在该时刻可以查',
  async (timeBasis) => {
    const options = timeBasis === undefined ? {} : { timeBasis };
    const early = setup(refundPage([]));
    await rejection(() => early.adapter.listRefunds(beforeCutoff, ctx, options), 'invalid_dto');
    expect(early.transport).not.toHaveBeenCalled();
    expect(early.dataokeCredentials).not.toHaveBeenCalled();

    const exact = setup(refundPage([]));
    await refunds(exact.adapter, atCutoff, options);
    expect(exact.requests).toHaveLength(1);
    expect(exact.requests[0]).toMatchObject({ startTime: '2022-12-20 00:00:00' });
  },
);

it.each(['refund_created', 'settle', 'refund_finished'] as const)(
  '[AC-B1-04z#5] queryType 1–3（timeBasis=%s）起点早于 2022-12-20 照常请求',
  async (timeBasis) => {
    const s = setup(refundPage([]));
    await refunds(s.adapter, beforeCutoff, { timeBasis });
    expect(s.requests.length).toBeGreaterThanOrEqual(1);
    expect(s.requests[0]).toMatchObject({ startTime: '2022-12-19 23:59:59' });
  },
);

it('[AC-B1-04z#6] 非整秒窗口向外取整到秒（from 向下、to 向上），跨北京零点按 UTC+8 落到次日', async () => {
  const s = setup(refundPage([]));
  await refunds(s.adapter, { from: '2026-10-29T15:30:00.123Z', to: '2026-10-29T16:30:00.456Z' });
  expect(s.requests[0]).toMatchObject({
    startTime: '2026-10-29 23:30:00',
    endTime: '2026-10-30 00:30:01',
  });
});

it.each(['UTC', 'America/New_York', 'Asia/Tokyo'])(
  '[AC-B1-04z#7] 进程时区 %s 下发给上游的仍是北京时间；注入时钟前进不改变同一窗口的文本',
  async (zone) => {
    vi.stubEnv('TZ', zone);
    const s = setup(refundPage([]));
    await refunds(s.adapter);
    s.clock.advanceMs(30 * 86_400_000);
    await refunds(s.adapter);
    expect(s.requests.map((q) => [q.startTime, q.endTime])).toEqual([
      ['2026-10-30 10:00:00', '2026-10-30 11:00:00'],
      ['2026-10-30 10:00:00', '2026-10-30 11:00:00'],
    ]);
  },
);

it.each([
  ['相等', { from: win.from, to: win.from }],
  ['逆序', { from: win.to, to: win.from }],
  ['起点不是时刻', { from: 'not-a-time', to: win.to }],
  ['终点不是时刻', { from: win.from, to: 'not-a-time' }],
] as const)('[AC-B1-04z#8] 时间窗%s → invalid_dto，不取凭据、不发请求', async (_name, window) => {
  const s = setup(refundPage([]));
  await rejection(() => s.adapter.listRefunds(window, ctx), 'invalid_dto');
  expect(s.transport).not.toHaveBeenCalled();
  expect(s.dataokeCredentials).not.toHaveBeenCalled();
  expect(s.taobaoCredentials).not.toHaveBeenCalled();
});

it('[AC-B1-04z#9] 归档上下文是调用方 app 与 kind=order；直接调用（无 gateUpstream）把 ctx.signal 挂在传输请求上', async () => {
  const controller = new AbortController();
  const s = setup(refundPage([]));
  await listed(s.adapter.listRefunds(win, { ...ctx, signal: controller.signal }));
  expect(s.transport).toHaveBeenCalledTimes(1);
  const request = s.calls[0]!.request;
  expect(request.archive).toEqual({ appId: ctx.appId, kind: 'order' });
  expect(request.signal).toBe(controller.signal);
});

it('[AC-B1-04z#10] 维权不按推广位过滤：不读推广位端口，没有推广位端口也照常请求、原样返回', async () => {
  const wired = setup(refundPage([refundOf(1), refundOf(2)]));
  const { items } = await refunds(wired.adapter);
  expect(items.map((refund) => refund.order_id)).toEqual([
    refundOf(1).tb_trade_id,
    refundOf(2).tb_trade_id,
  ]);
  expect(wired.orderSlots).not.toHaveBeenCalled();

  const bare = setup(refundPage([refundOf(3)]), { slots: null });
  const result = await refunds(bare.adapter);
  expect(result.items.map((refund) => refund.order_id)).toEqual([refundOf(3).tb_trade_id]);
  expect(bare.transport).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04z#11] 没有大淘客订单源 → adapter_unimplemented，不取任何凭据、不发请求', async () => {
  const s = setup(refundPage([refundOf(1)]), { source: false });
  await rejection(() => s.adapter.listRefunds(win, ctx), 'adapter_unimplemented');
  expect(s.transport).not.toHaveBeenCalled();
  expect(s.dataokeCredentials).not.toHaveBeenCalled();
  expect(s.taobaoCredentials).not.toHaveBeenCalled();
  expect(s.taobaoTransport).not.toHaveBeenCalled();
});
