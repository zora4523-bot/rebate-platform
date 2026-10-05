import { expect, it, vi } from 'vitest';
import {
  createGovernedAdapter,
  type CallCtx,
  type UnionAdapter,
  type UnionIdentity,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  adapter,
  endpoint,
  quota,
  online,
  window,
  item,
  LinkingIdentity,
  ManualScheduler,
  flush,
  observe,
  ending,
  errorCode,
} from './kit.ts';

it('[AC-B1-04b-GOV#1] 搜索成功保留 DTO、分页游标、参数，并传递 Governor 信号', async () => {
  const raw = adapter();
  const result = { items: [item], nextCursor: 'opaque-next' };
  const search = vi.fn(async () => result);
  raw.searchItems = search;
  const scheduler = new ManualScheduler();
  const port = createGovernedAdapter(raw, { endpoint: endpoint(), scheduler, quota: quota() });
  const query = { keyword: '领域测试', cursor: 'opaque-before' };
  expect(await port.searchItems(query, online)).toEqual(result);
  expect(search).toHaveBeenCalledWith(
    query,
    expect.objectContaining({ ...online, signal: expect.any(AbortSignal) }),
  );
  expect(scheduler.pending).toBe(0);
});

it('[AC-B1-04b-GOV#2] 幂等读最多重试两次，失败之间指数退避', async () => {
  const scheduler = new ManualScheduler();
  const attempts: number[] = [];
  const failure = new Error('synthetic read failure');
  const raw = adapter();
  raw.searchItems = async () => {
    attempts.push(scheduler.now());
    throw failure;
  };
  const port = createGovernedAdapter(raw, { endpoint: endpoint(), scheduler, quota: quota() });
  const result = observe(port.searchItems({ keyword: 'test' }, online));
  await scheduler.advance(10_000);
  expect(result.error).toBe(failure);
  expect(attempts).toHaveLength(3);
  const firstDelay = (attempts[1] ?? 0) - (attempts[0] ?? 0);
  const secondDelay = (attempts[2] ?? 0) - (attempts[1] ?? 0);
  expect(firstDelay).toBeGreaterThan(0);
  expect(secondDelay).toBe(firstDelay * 2);
  expect(scheduler.pending).toBe(0);
});

type Invoke = (port: UnionAdapter, ctx: CallCtx) => Promise<unknown>;
const reads: readonly [string, Invoke][] = [
  ['getItem', (port, ctx) => port.getItem({ platform: 'jd', itemId: 'item-A' }, ctx)],
  ['resolveLink', (port, ctx) => port.resolveLink('https://example.invalid/item', ctx)],
  ['listOrders', (port, ctx) => port.listOrders(window, { cursor: 'page-2' }, ctx)],
  ['listRefunds', (port, ctx) => port.listRefunds!(window, ctx)],
  ['listPunishments', (port, ctx) => port.listPunishments!(window, ctx)],
  ['materialFeed', (port, ctx) => port.materialFeed!({ cursor: 'page-2' }, ctx)],
];

it.each(reads)('[AC-B1-04b-GOV#3] %s 接入幂等读治理，不漏掉选配接口', async (_name, invoke) => {
  const scheduler = new ManualScheduler();
  let attempts = 0;
  const fail = async (): Promise<never> => {
    attempts += 1;
    throw new Error('synthetic outage');
  };
  const raw: UnionAdapter = {
    ...adapter(),
    getItem: fail,
    resolveLink: fail,
    listOrders: fail,
    listRefunds: fail,
    listPunishments: fail,
    materialFeed: fail,
  };
  const port = createGovernedAdapter(raw, { endpoint: endpoint(), scheduler, quota: quota() });
  const result = observe(invoke(port, { ...online, purpose: 'order_sync' }));
  await scheduler.advance(10_000);
  expect(result.settled).toBe('rejected');
  expect(attempts).toBe(3);
});

const writes: readonly [string, Invoke][] = [
  [
    'convert',
    (port, ctx) =>
      port.convert(
        { item: { platform: 'jd', itemId: 'item-A' }, idempotencyKey: 'same-key' },
        new LinkingIdentity(),
        ctx,
      ),
  ],
  ['bindPublisher', (port, ctx) => port.bindPublisher!({ authorizationCode: 'synthetic' }, ctx)],
  [
    'createTaolijin',
    (port, ctx) =>
      port.createTaolijin!(
        { item: { platform: 'jd' }, amount_fen: 1n, idempotencyKey: 'same-key' },
        ctx,
      ),
  ],
];

it.each(writes)(
  '[AC-B1-04b-GOV#4] %s 失败不自动重发；携带幂等键也不改变此规则',
  async (_name, invoke) => {
    const scheduler = new ManualScheduler();
    const failure = new Error('synthetic unknown write result');
    const fail = vi.fn(async (): Promise<never> => {
      throw failure;
    });
    const raw: UnionAdapter = {
      ...adapter(),
      convert: fail,
      bindPublisher: fail,
      createTaolijin: fail,
    };
    const port = createGovernedAdapter(raw, { endpoint: endpoint(), scheduler, quota: quota() });
    const result = observe(invoke(port, online));
    await scheduler.advance(60_000);
    expect(result.error).toBe(failure);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(0);
  },
);

it.each([
  ['online', 3000],
  ['order_sync', 10000],
  ['pool_refresh', 10000],
] as const)('[AC-B1-04b-GOV#5] %s 超时在 %i 毫秒中止 adapter 的信号', async (purpose, timeout) => {
  const scheduler = new ManualScheduler();
  let signal: AbortSignal | undefined;
  const raw: UnionAdapter = {
    ...adapter(),
    bindPublisher: (_req, ctx) => {
      signal = ctx.signal;
      return new Promise((_resolve, reject) =>
        ctx.signal?.addEventListener('abort', () => reject(ctx.signal?.reason), { once: true }),
      );
    },
  };
  const port = createGovernedAdapter(raw, { endpoint: endpoint(), scheduler, quota: quota() });
  const result = observe(
    port.bindPublisher!({ authorizationCode: 'synthetic' }, { ...online, purpose }),
  );
  await scheduler.advance(timeout - 1);
  expect({ ending: ending(result), aborted: signal?.aborted }).toEqual({
    ending: 'pending',
    aborted: false,
  });
  await scheduler.advance(1);
  expect({ ending: ending(result), aborted: signal?.aborted }).toEqual({
    ending: 'timeout',
    aborted: true,
  });
  expect(scheduler.pending).toBe(0);
});

it('[AC-B1-04b-GOV#6] 20 次中恰好 50% 失败不熔断，超过后阻断 30 秒且共享到其他在线方法', async () => {
  const scheduler = new ManualScheduler();
  let calls = 0;
  const raw: UnionAdapter = {
    ...adapter(),
    bindPublisher: async () => {
      calls += 1;
      if (calls <= 10 || calls === 21) throw new Error('synthetic outage');
      return { relationId: 'relation' };
    },
  };
  const search = vi.fn(raw.searchItems);
  raw.searchItems = search;
  const port = createGovernedAdapter(raw, { endpoint: endpoint(), scheduler, quota: quota() });
  for (let i = 0; i < 21; i += 1) {
    const result = observe(port.bindPublisher!({ authorizationCode: 'synthetic' }, online));
    await flush();
    expect(result.settled).toBe(i < 10 || i === 20 ? 'rejected' : 'resolved');
  }
  expect(calls).toBe(21);
  await expect(port.searchItems({ keyword: 'blocked' }, online)).rejects.toMatchObject({
    code: 'circuit_open',
  });
  expect(search).toHaveBeenCalledTimes(0);
  await scheduler.advance(29999);
  await expect(port.searchItems({ keyword: 'still-blocked' }, online)).rejects.toMatchObject({
    code: 'circuit_open',
  });
  await scheduler.advance(1);
  expect(await port.searchItems({ keyword: 'recovered' }, online)).toEqual({
    items: [item],
    nextCursor: null,
  });
});

it('[AC-B1-04b-GOV#7] 10 秒窗外失败不积累；少于 20 次请求不熔断', async () => {
  const scheduler = new ManualScheduler();
  const fail = vi.fn(async (): Promise<never> => {
    throw new Error('synthetic outage');
  });
  const raw: UnionAdapter = { ...adapter(), bindPublisher: fail };
  const port = createGovernedAdapter(raw, { endpoint: endpoint(), scheduler, quota: quota() });
  for (let i = 0; i < 19; i += 1) {
    await expect(port.bindPublisher!({ authorizationCode: 'synthetic' }, online)).rejects.toThrow(
      'synthetic outage',
    );
  }
  await scheduler.advance(10_000);
  await expect(port.bindPublisher!({ authorizationCode: 'synthetic' }, online)).rejects.toThrow(
    'synthetic outage',
  );
  await expect(port.bindPublisher!({ authorizationCode: 'synthetic' }, online)).rejects.toThrow(
    'synthetic outage',
  );
  expect(fail).toHaveBeenCalledTimes(21);
});

it('[AC-B1-04b-GOV#14] 9 999 毫秒内的失败仍计入 10 秒窗，第 20 次失败后熔断', async () => {
  const scheduler = new ManualScheduler();
  const fail = vi.fn(async (): Promise<never> => {
    throw new Error('synthetic outage');
  });
  const port = createGovernedAdapter(
    { ...adapter(), bindPublisher: fail },
    { endpoint: endpoint(), scheduler, quota: quota() },
  );
  for (let i = 0; i < 19; i += 1) {
    await expect(port.bindPublisher!({ authorizationCode: 'synthetic' }, online)).rejects.toThrow(
      'synthetic outage',
    );
  }
  await scheduler.advance(9999);
  await expect(port.bindPublisher!({ authorizationCode: 'synthetic' }, online)).rejects.toThrow(
    'synthetic outage',
  );
  await expect(
    port.bindPublisher!({ authorizationCode: 'synthetic' }, online),
  ).rejects.toMatchObject({
    code: 'circuit_open',
  });
  expect(fail).toHaveBeenCalledTimes(20);
});

it('[AC-B1-04b-GOV#15] 前 10 次失败、9 次成功、第 20 次失败即以 11/20 触发熔断', async () => {
  const scheduler = new ManualScheduler();
  let calls = 0;
  const bind = vi.fn(async () => {
    calls += 1;
    if (calls <= 10 || calls === 20) throw new Error('synthetic outage');
    return { relationId: 'relation' };
  });
  const port = createGovernedAdapter(
    { ...adapter(), bindPublisher: bind },
    { endpoint: endpoint(), scheduler, quota: quota() },
  );
  for (let i = 0; i < 20; i += 1) {
    const result = port.bindPublisher!({ authorizationCode: 'synthetic' }, online);
    if (i < 10 || i === 19) {
      await expect(result).rejects.toThrow('synthetic outage');
    } else {
      await expect(result).resolves.toEqual({ relationId: 'relation' });
    }
  }
  await expect(
    port.bindPublisher!({ authorizationCode: 'synthetic' }, online),
  ).rejects.toMatchObject({
    code: 'circuit_open',
  });
  expect(bind).toHaveBeenCalledTimes(20);
});

it('[AC-B1-04b-GOV#8] 配额拒绝时不调用上游、不重试，按调用用途取令牌', async () => {
  const scheduler = new ManualScheduler();
  const take = vi.fn(() => false);
  const search = vi.fn(adapter().searchItems);
  const orders = vi.fn(adapter().listOrders);
  const port = createGovernedAdapter(
    { ...adapter(), searchItems: search, listOrders: orders },
    {
      endpoint: { ...endpoint(), quotaKey: 'custom-account-bucket' },
      scheduler,
      quota: { bucketKey: 'custom-account-bucket', tryAcquire: take },
    },
  );
  await expect(port.searchItems({ keyword: 'test' }, online)).rejects.toMatchObject({
    code: 'quota_exceeded',
  });
  await expect(
    port.listOrders(window, {}, { ...online, purpose: 'order_sync' }),
  ).rejects.toMatchObject({ code: 'quota_exceeded' });
  await expect(
    port.searchItems({ keyword: 'refresh' }, { ...online, purpose: 'pool_refresh' }),
  ).rejects.toMatchObject({ code: 'quota_exceeded' });
  expect(take.mock.calls).toEqual([['online'], ['order_sync'], ['pool_refresh']]);
  expect(search).toHaveBeenCalledTimes(0);
  expect(orders).toHaveBeenCalledTimes(0);
  expect(scheduler.pending).toBe(0);
});

it('[AC-B1-04b-GOV#9] 重试也取配额，第二次令牌被拒后停止', async () => {
  const scheduler = new ManualScheduler();
  const take = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  const search = vi.fn(async (): Promise<never> => {
    throw new Error('synthetic outage');
  });
  const port = createGovernedAdapter(
    { ...adapter(), searchItems: search },
    {
      endpoint: endpoint(),
      scheduler,
      quota: { bucketKey: 'account:jd', tryAcquire: take },
    },
  );
  const result = observe(port.searchItems({ keyword: 'test' }, online));
  await scheduler.advance(10_000);
  expect(ending(result)).toBe('quota_exceeded');
  expect(search).toHaveBeenCalledTimes(1);
  expect(take.mock.calls).toEqual([['online'], ['online']]);
});

it('[AC-B1-04b-GOV#10] 配置与配额桶键或平台不匹配时拒绝装配', () => {
  for (const options of [
    { endpoint: endpoint(), scheduler: new ManualScheduler(), quota: quota('different-account') },
    { endpoint: endpoint('pdd'), scheduler: new ManualScheduler(), quota: quota('account:pdd') },
  ]) {
    expect(errorCode(() => createGovernedAdapter(adapter(), options))).toBe('invalid_endpoint');
  }
});

it('[AC-B1-04b-GOV#11] replay 将配置 URL 与 X-Scenario 交给 adapter，不改变原 context', async () => {
  const scheduler = new ManualScheduler();
  const search = vi.fn(adapter().searchItems);
  const port = createGovernedAdapter(
    { ...adapter(), searchItems: search },
    { endpoint: endpoint(), scheduler, quota: quota() },
  );
  const ctx: CallCtx = Object.freeze({
    ...online,
    scenario: 'synthetic-timeout',
    baseUrl: 'https://example.invalid/untrusted',
    headers: { 'X-Scenario': 'untrusted' },
  });
  await port.searchItems({ keyword: 'test' }, ctx);
  expect(search).toHaveBeenCalledWith(
    { keyword: 'test' },
    expect.objectContaining({
      baseUrl: 'http://wiremock:8080/jd',
      headers: { 'X-Scenario': 'synthetic-timeout' },
      signal: expect.any(AbortSignal),
    }),
  );
  expect(ctx.baseUrl).toBe('https://example.invalid/untrusted');
  expect(ctx.headers).toEqual({ 'X-Scenario': 'untrusted' });
});

it('[AC-B1-04b-GOV#12] live 不把回放场景头传给上游', async () => {
  const search = vi.fn(adapter().searchItems);
  const port = createGovernedAdapter(
    { ...adapter(), searchItems: search },
    {
      endpoint: { ...endpoint(), mode: 'live', baseUrl: 'https://example.invalid/live' },
      scheduler: new ManualScheduler(),
      quota: quota(),
    },
  );
  await port.searchItems(
    { keyword: 'test' },
    { ...online, scenario: 'synthetic', headers: { 'X-Scenario': 'injected' } },
  );
  const call = search.mock.calls[0];
  expect(call?.[1].headers?.['X-Scenario']).toBeUndefined();
  expect(call?.[1].baseUrl).toBe('https://example.invalid/live');
});

it('[AC-B1-04b-GOV#13] 不支持的选配接口在包装后仍缺省', () => {
  const port = createGovernedAdapter(adapter(), {
    endpoint: endpoint(),
    scheduler: new ManualScheduler(),
    quota: quota(),
  });
  expect([
    port.bindPublisher,
    port.listRefunds,
    port.listPunishments,
    port.materialFeed,
    port.createTaolijin,
  ]).toEqual([undefined, undefined, undefined, undefined, undefined]);
});

it('[AC-B1-04b-IDENTITY#1] 外部 JSON 即使字段齐全也不能成为 UnionIdentity', async () => {
  const convert = vi.fn(adapter().convert);
  const port = createGovernedAdapter(
    { ...adapter(), convert },
    { endpoint: endpoint(), scheduler: new ManualScheduler(), quota: quota() },
  );
  const forged = {
    claims: {
      appId: 'app-a',
      userId: 'user-a',
      platform: 'jd',
      promotionSlot: 'forged',
      relationId: 'forged',
    },
  };
  // @ts-expect-error A structurally identical external object is not a nominal server identity.
  const identity: UnionIdentity = forged;
  await expect(
    port.convert({ item: { platform: 'jd' }, idempotencyKey: 'same-key' }, identity, online),
  ).rejects.toMatchObject({ code: 'invalid_identity' });
  expect(convert).toHaveBeenCalledTimes(0);
});

it('[AC-B1-04b-IDENTITY#2] convert 保留服务端身份、幂等键与调用参数', async () => {
  const convert = vi.fn(adapter().convert);
  const port = createGovernedAdapter(
    { ...adapter(), convert },
    { endpoint: endpoint(), scheduler: new ManualScheduler(), quota: quota() },
  );
  const identity = new LinkingIdentity();
  const request = {
    item: { platform: 'jd' as const, itemId: 'item-A' },
    idempotencyKey: 'same-key',
  };
  expect(await port.convert(request, identity, online)).toEqual({
    kind: 'url',
    url: 'https://example.invalid/result',
  });
  expect(convert).toHaveBeenCalledWith(request, identity, expect.objectContaining(online));
});

it('[AC-B1-04b-IDENTITY#3] 跨 app 或跨平台身份在发起转链前拒绝', async () => {
  const convert = vi.fn(adapter().convert);
  const port = createGovernedAdapter(
    { ...adapter(), convert },
    { endpoint: endpoint(), scheduler: new ManualScheduler(), quota: quota() },
  );
  for (const identity of [new LinkingIdentity('app-b'), new LinkingIdentity('app-a', 'pdd')]) {
    await expect(
      port.convert({ item: { platform: 'jd' }, idempotencyKey: 'same-key' }, identity, online),
    ).rejects.toMatchObject({ code: 'invalid_identity' });
  }
  expect(convert).toHaveBeenCalledTimes(0);
});
