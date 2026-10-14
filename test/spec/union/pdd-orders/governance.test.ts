import { expect, it, vi } from 'vitest';
import type { QuotaLimiter, Scheduler } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createGovernedAdapter,
  UnionError,
  type CallCtx,
  type UnionAdapter,
  type UnionOrder,
} from '../../../../apps/api/src/modules/union/index.ts';
import { adapter as basicAdapter } from '../skeleton/kit.ts';
import { ctx, endpoint } from './kit.ts';

// No wall-clock waits: backoff resolves immediately, timeouts wait only for cancellation.
const scheduler: Scheduler = {
  now: () => 0,
  sleep: (ms, signal) =>
    ms < 3000
      ? Promise.resolve()
      : new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
};
const order: UnionOrder = {
  platform: 'pdd',
  order_id: 'synthetic-governed-order',
  paid_fen: 8765432n,
  commission_fen: 76543n,
  return_status: 1,
};

function govern(raw: UnionAdapter, take: QuotaLimiter['tryAcquire'] = () => true) {
  return createGovernedAdapter(raw, {
    endpoint,
    scheduler,
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: take },
  });
}

it('[AC-B1-04i-GOV#1] 公共 UnionAdapter 暴露可选详情端口；包装保留有能力者并保持其他平台缺省', () => {
  const capable: UnionAdapter = { ...basicAdapter('pdd'), getPddOrderDetail: async () => order };
  expect(govern(capable).getPddOrderDetail).toBeTypeOf('function');
  expect(govern(basicAdapter('pdd')).getPddOrderDetail).toBeUndefined();
  const jd = createGovernedAdapter(basicAdapter('jd'), {
    scheduler,
    endpoint: { ...endpoint, platform: 'jd' },
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: () => true },
  });
  expect(jd.getPddOrderDetail).toBeUndefined();
});

it('[AC-B1-04i-GOV#2] 详情传递订单号、app_id 和用途；绑定原 adapter、注入 signal 与配置 URL', async () => {
  const raw = basicAdapter('pdd');
  const read = vi.fn(async function (this: UnionAdapter, orderSn: string, call: CallCtx) {
    expect(this).toBe(raw);
    expect(orderSn).toBe(order.order_id);
    expect(call).toMatchObject({
      appId: ctx.appId,
      requestId: ctx.requestId,
      purpose: 'order_sync',
      baseUrl: endpoint.baseUrl,
      signal: expect.any(AbortSignal),
      headers: {},
    });
    return order;
  });
  raw.getPddOrderDetail = read;
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
  const port = govern(raw, take);
  expect(port.getPddOrderDetail).toBeTypeOf('function');
  const caller: CallCtx = Object.freeze({
    ...ctx,
    baseUrl: 'https://untrusted.invalid',
    headers: { test: 'untrusted' },
  });
  expect(await port.getPddOrderDetail!(order.order_id, caller)).toBe(order);
  expect(read).toHaveBeenCalledTimes(1);
  expect(take.mock.calls).toEqual([['order_sync']]);
  expect(caller.signal).toBeUndefined();
  expect(caller.baseUrl).toBe('https://untrusted.invalid');
});

it.each(['upstream_unavailable', 'rate_limited'] as const)(
  '[AC-B1-04i-GOV#3] 详情 %s 作为幂等读重试两次，每次都消耗配额',
  async (code) => {
    const read = vi.fn(async (): Promise<UnionOrder> => {
      throw new UnionError(code, 'synthetic failure', 'pdd');
    });
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    const port = govern({ ...basicAdapter('pdd'), getPddOrderDetail: read }, take);
    expect(port.getPddOrderDetail).toBeTypeOf('function');
    await expect(port.getPddOrderDetail!(order.order_id, ctx)).rejects.toMatchObject({ code });
    expect(read).toHaveBeenCalledTimes(3);
    expect(take.mock.calls).toEqual([['order_sync'], ['order_sync'], ['order_sync']]);
  },
);

it('[AC-B1-04i-GOV#4] 详情暂时失败后恢复，透传成功 DTO', async () => {
  const read = vi
    .fn<NonNullable<UnionAdapter['getPddOrderDetail']>>()
    .mockRejectedValueOnce(new UnionError('upstream_unavailable', 'synthetic failure', 'pdd'))
    .mockResolvedValue(order);
  const port = govern({ ...basicAdapter('pdd'), getPddOrderDetail: read });
  expect(port.getPddOrderDetail).toBeTypeOf('function');
  expect(await port.getPddOrderDetail!(order.order_id, ctx)).toBe(order);
  expect(read).toHaveBeenCalledTimes(2);
});

it.each(['invalid_dto', 'upstream_rejected'] as const)(
  '[AC-B1-04i-GOV#5] 详情业务拒绝 %s 不重试',
  async (code) => {
    const read = vi.fn(async (): Promise<UnionOrder> => {
      throw new UnionError(code, 'synthetic rejection', 'pdd');
    });
    const port = govern({ ...basicAdapter('pdd'), getPddOrderDetail: read });
    expect(port.getPddOrderDetail).toBeTypeOf('function');
    await expect(port.getPddOrderDetail!(order.order_id, ctx)).rejects.toMatchObject({ code });
    expect(read).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-04i-GOV#6] 配额拒绝时详情不会绕过治理直达上游', async () => {
  const read = vi.fn(async () => order);
  const port = govern({ ...basicAdapter('pdd'), getPddOrderDetail: read }, () => false);
  expect(port.getPddOrderDetail).toBeTypeOf('function');
  await expect(port.getPddOrderDetail!(order.order_id, ctx)).rejects.toMatchObject({
    code: 'quota_exceeded',
  });
  expect(read).not.toHaveBeenCalled();
});
