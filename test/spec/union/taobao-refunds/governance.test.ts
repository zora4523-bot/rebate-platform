import { expect, it, vi } from 'vitest';
import type { QuotaLimiter } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  UnionAdapter,
  UpstreamGate,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  ctx,
  failureReply,
  govern,
  listed,
  positionOf,
  punishAnswer,
  punishments,
  punishOf,
  punishPage,
  refundAnswer,
  refundOf,
  refundPage,
  refunds,
  rejection,
  setup,
  walkRefunds,
  win,
  type Answer,
} from './kit.ts';

// 计量照 B1-04f / B1-04w：适配器声明 listRefundsMetering / listPunishmentsMetering = 'per_request'，
// 包装层不再整体取配额，而是把 CallCtx.gateUpstream 交给适配器，每个上游请求各取一个配额（用途
// order_sync）、各有自己的取消信号与重试；调用方伪造的 gateUpstream 被换掉。不发请求的调用（游标不合法、
// 推广位清单为空）不取配额。包装层把第三个参数（游标、口径）原样交给适配器。

const W0 = '2026-10-30 10:00:00';
const refundPages = [[refundOf(1)], [refundOf(2)], [refundOf(3)]];
const refundIds = refundPages.flat().map((input) => input.refund_suit_id);
const punishPages = [[punishOf(1)], [punishOf(2)]];

function allowAll() {
  return vi.fn<QuotaLimiter['tryAcquire']>(() => true);
}

it('[AC-B1-04z#62] 适配器声明 listRefundsMetering / listPunishmentsMetering = per_request', () => {
  const adapter: UnionAdapter = setup().adapter;
  expect(adapter.listRefundsMetering).toBe('per_request');
  expect(adapter.listPunishmentsMetering).toBe('per_request');
  expect(adapter.listOrdersMetering).toBe('per_request');
});

it('[AC-B1-04z#63] 维权：每个上游请求前恰取一次配额（order_sync），每次尝试的取消信号各不相同', async () => {
  const events: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const answer = refundAnswer({ [W0]: refundPages });
  const s = setup((call, signal) => {
    events.push(`request:${call.query.positionIndex ?? 'first'}`);
    signals.push(signal);
    return answer(call, signal);
  });
  const take = vi.fn<QuotaLimiter['tryAcquire']>((purpose) => {
    events.push(`quota:${purpose}`);
    return true;
  });
  const { items } = await refunds(govern(s.adapter, take));
  expect(items.map((refund) => refund.refund_id)).toEqual(refundIds);
  expect(events).toEqual([
    'quota:order_sync',
    'request:first',
    'quota:order_sync',
    `request:${positionOf(0, 0)}`,
    'quota:order_sync',
    `request:${positionOf(0, 1)}`,
  ]);
  expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  expect(new Set(signals).size).toBe(3);
});

it('[AC-B1-04z#64] 违规：每个上游请求前恰取一次配额，推广位清单为空时不发请求也不取配额', async () => {
  const s = setup(punishAnswer({ [W0]: punishPages }));
  const take = allowAll();
  const { items } = await punishments(govern(s.adapter, take));
  expect(items.map((punish) => punish.order_id)).toEqual(
    punishPages.flat().map((input) => input.tb_trade_id),
  );
  expect(take).toHaveBeenCalledTimes(2);
  expect(s.transport).toHaveBeenCalledTimes(2);

  const empty = setup(punishPage([punishOf(1)]), { slots: [] });
  const none = allowAll();
  const page = await listed(govern(empty.adapter, none).listPunishments?.(win, ctx));
  expect(page).toEqual({ items: [], nextCursor: null });
  expect(empty.transport).not.toHaveBeenCalled();
  expect(none).not.toHaveBeenCalled();
});

it('[AC-B1-04z#65] 包装层把口径与游标原样交给适配器：timeBasis 决定 queryType，续页带上 position_index', async () => {
  const s = setup(refundAnswer({ [W0]: refundPages }));
  const { items } = await refunds(govern(s.adapter, allowAll()), win, {
    timeBasis: 'refund_finished',
  });
  expect(items.map((refund) => refund.refund_id)).toEqual(refundIds);
  expect(s.requests.map((q) => [q.queryType, q.positionIndex])).toEqual([
    ['3', undefined],
    ['3', positionOf(0, 0)],
    ['3', positionOf(0, 1)],
  ]);
});

it('[AC-B1-04z#66] 不发请求的调用不取配额：游标不合法 → invalid_dto，未取配额、未取凭据', async () => {
  const s = setup(refundPage([]));
  const take = allowAll();
  const governed = govern(s.adapter, take);
  await rejection(() => governed.listRefunds?.(win, ctx, { cursor: 'garbage' }), 'invalid_dto');
  await rejection(() => governed.listPunishments?.(win, ctx, { cursor: 'garbage' }), 'invalid_dto');
  expect(take).not.toHaveBeenCalled();
  expect(s.transport).not.toHaveBeenCalled();
  expect(s.dataokeCredentials).not.toHaveBeenCalled();
});

it('[AC-B1-04z#67] 配额被拒 → quota_exceeded，传输层没收到请求；只够 1 次时第二页才被拒、不从首页重来', async () => {
  const refused = setup(refundAnswer({ [W0]: refundPages }));
  await rejection(
    () => govern(refused.adapter, () => false).listRefunds?.(win, ctx),
    'quota_exceeded',
  );
  expect(refused.transport).not.toHaveBeenCalled();

  let remaining = 1;
  const once = setup(refundAnswer({ [W0]: refundPages }));
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() => remaining-- > 0);
  await expect(walkRefunds(govern(once.adapter, take))).rejects.toMatchObject({
    code: 'quota_exceeded',
  });
  expect(once.transport).toHaveBeenCalledTimes(1);
  expect(once.requests.map((q) => q.positionIndex)).toEqual([undefined]);
});

it('[AC-B1-04z#68] 调用方伪造的 gateUpstream 被包装层换掉，翻页不绕过配额（维权与违规）', async () => {
  const forged = vi.fn(() => {
    throw new Error('forged gate must not run');
  });
  const caller = { ...ctx, gateUpstream: forged as unknown as UpstreamGate };

  const r = setup(refundAnswer({ [W0]: refundPages }));
  const rTake = allowAll();
  const result = await refunds(govern(r.adapter, rTake), win, {}, caller);
  expect(result.items.map((refund) => refund.refund_id)).toEqual(refundIds);
  expect(rTake).toHaveBeenCalledTimes(r.transport.mock.calls.length);
  expect(r.transport).toHaveBeenCalledTimes(3);

  const p = setup(punishAnswer({ [W0]: punishPages }));
  const pTake = allowAll();
  await punishments(govern(p.adapter, pTake), win, {}, caller);
  expect(pTake).toHaveBeenCalledTimes(p.transport.mock.calls.length);
  expect(p.transport).toHaveBeenCalledTimes(2);
  expect(forged).not.toHaveBeenCalled();
});

it('[AC-B1-04z#69] 上游 5xx 只重试那一个请求（每次尝试各取一次配额），不从首页重来', async () => {
  const answer = refundAnswer({ [W0]: refundPages });
  let failed = false;
  const flaky: Answer = (call, signal) => {
    if (call.query.positionIndex === positionOf(0, 0) && !failed) {
      failed = true;
      return failureReply(503);
    }
    return answer(call, signal);
  };
  const s = setup(flaky);
  const take = allowAll();
  const { items } = await refunds(govern(s.adapter, take));
  expect(items.map((refund) => refund.refund_id)).toEqual(refundIds);
  expect(s.requests.map((q) => q.positionIndex)).toEqual([
    undefined,
    positionOf(0, 0),
    positionOf(0, 0),
    positionOf(0, 1),
  ]);
  expect(take).toHaveBeenCalledTimes(4);
});

it('[AC-B1-04z#70] 包装后没有订单源的淘宝适配器：listRefunds / listPunishments 都是 adapter_unimplemented，不发请求', async () => {
  const s = setup(refundPage([refundOf(1)]), { source: false });
  const take = allowAll();
  const governed = govern(s.adapter, take);
  expect(governed.listRefunds).toBeTypeOf('function');
  expect(governed.listPunishments).toBeTypeOf('function');
  await rejection(() => governed.listRefunds?.(win, ctx), 'adapter_unimplemented');
  await rejection(() => governed.listPunishments?.(win, ctx), 'adapter_unimplemented');
  expect(s.transport).not.toHaveBeenCalled();
  expect(s.dataokeCredentials).not.toHaveBeenCalled();
});
