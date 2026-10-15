import { expect, it, vi } from 'vitest';
import type { QuotaLimiter, Scheduler } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createGovernedAdapter,
  UnionError,
  type CallCtx,
  type PddAuthorityUrl,
  type UnionAdapter,
  type UnionIdentity,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  authorityReply,
  convertReply,
  ctx,
  endpoint,
  identity,
  mobile,
  req,
  setup,
  TestIdentity,
} from './kit.ts';

// 注入固定调度器：退避立即结束，超时只等待取消；不读取宿主时钟或监听端口。
const scheduler: Scheduler = {
  now: () => 0,
  sleep: (ms, signal) =>
    ms < 3000
      ? Promise.resolve()
      : new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
};

function govern(raw: UnionAdapter, take: QuotaLimiter['tryAcquire'] = () => true) {
  return createGovernedAdapter(raw, {
    endpoint,
    scheduler,
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: take },
  });
}

function basicAdapter(): UnionAdapter {
  return {
    platform: 'pdd',
    searchItems: async () => ({ items: [], nextCursor: null }),
    getItem: async () => {
      throw new Error('unused synthetic port');
    },
    resolveLink: async () => ({ item: req.item }),
    convert: async () => ({ kind: 'url', url: mobile }),
    listOrders: async () => ({ items: [], nextCursor: null }),
  };
}

it('[AC-B1-04h-GOV#1] 新可选端口有能力才出现；其他适配器保持缺省', () => {
  const raw = basicAdapter();
  raw.pddAuthorityUrl = async () => ({ url: mobile });
  expect(govern(raw).pddAuthorityUrl).toBeTypeOf('function');
  expect(govern(basicAdapter()).pddAuthorityUrl).toBeUndefined();
});

it.each(['upstream_unavailable', 'rate_limited'] as const)(
  '[AC-B1-04h-GOV#2] 备案链接 %s 是幂等读，重试两次且每次扣配额',
  async (code) => {
    const read = vi.fn(async (): Promise<PddAuthorityUrl> => {
      throw new UnionError(code, 'synthetic failure', 'pdd');
    });
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    const port = govern({ ...basicAdapter(), pddAuthorityUrl: read }, take);
    expect(port.pddAuthorityUrl).toBeTypeOf('function');
    await expect(port.pddAuthorityUrl!(identity, ctx)).rejects.toMatchObject({ code });
    expect(read).toHaveBeenCalledTimes(3);
    expect(take.mock.calls).toEqual([['online'], ['online'], ['online']]);
  },
);

it('[AC-B1-04h-GOV#3] 备案链接重试后成功，绑定原 adapter，保留身份与 app_id、注入 signal', async () => {
  const raw = basicAdapter();
  const result: PddAuthorityUrl = { url: mobile };
  const contexts: CallCtx[] = [];
  raw.pddAuthorityUrl = vi.fn(async function (
    this: UnionAdapter,
    who: UnionIdentity,
    call: CallCtx,
  ) {
    expect(this).toBe(raw);
    expect(who).toBe(identity);
    contexts.push(call);
    if (contexts.length === 1) throw new UnionError('rate_limited', 'synthetic limit', 'pdd');
    return result;
  });
  const port = govern(raw);
  expect(port.pddAuthorityUrl).toBeTypeOf('function');
  const caller = Object.freeze({
    ...ctx,
    baseUrl: 'https://untrusted.invalid',
    headers: { injected: 'no' },
  });
  expect(await port.pddAuthorityUrl!(identity, caller)).toBe(result);
  expect(contexts).toHaveLength(2);
  for (const call of contexts) {
    expect(call).toMatchObject({
      appId: ctx.appId,
      requestId: ctx.requestId,
      purpose: 'online',
      baseUrl: endpoint.baseUrl,
      headers: {},
      signal: expect.any(AbortSignal),
    });
  }
  expect(caller.baseUrl).toBe('https://untrusted.invalid');
  expect(caller).not.toHaveProperty('signal');
});

it.each(['invalid_dto', 'upstream_rejected'] as const)(
  '[AC-B1-04h-GOV#4] 备案链接业务拒绝 %s 不重试',
  async (code) => {
    const read = vi.fn(async (): Promise<PddAuthorityUrl> => {
      throw new UnionError(code, 'synthetic rejection', 'pdd');
    });
    const port = govern({ ...basicAdapter(), pddAuthorityUrl: read });
    expect(port.pddAuthorityUrl).toBeTypeOf('function');
    await expect(port.pddAuthorityUrl!(identity, ctx)).rejects.toMatchObject({ code });
    expect(read).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-04h-GOV#5] 备案链接配额不足时不访问上游', async () => {
  const read = vi.fn(async () => ({ url: mobile }));
  const port = govern({ ...basicAdapter(), pddAuthorityUrl: read }, () => false);
  expect(port.pddAuthorityUrl).toBeTypeOf('function');
  await expect(port.pddAuthorityUrl!(identity, ctx)).rejects.toMatchObject({
    code: 'quota_exceeded',
  });
  expect(read).not.toHaveBeenCalled();
});

it('[AC-B1-04h-GOV#6] 备案链接拒绝跨 app、跨平台和伪造身份，拒绝发生在配额与上游之前', async () => {
  const read = vi.fn(async () => ({ url: mobile }));
  const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
  const port = govern({ ...basicAdapter(), pddAuthorityUrl: read }, take);
  expect(port.pddAuthorityUrl).toBeTypeOf('function');
  const forged = {
    claims: identity.claims,
    custom_parameters: identity.custom_parameters,
  } as unknown as UnionIdentity;
  for (const who of [
    new TestIdentity(undefined, { appId: 'other-app' }),
    new TestIdentity(undefined, { platform: 'jd' }),
    forged,
  ]) {
    await expect(port.pddAuthorityUrl!(who, ctx)).rejects.toMatchObject({
      code: 'invalid_identity',
    });
  }
  expect(read).not.toHaveBeenCalled();
  expect(take).not.toHaveBeenCalled();
});

it.each([
  { reply: {}, status: 503, code: 'upstream_unavailable' },
  {
    reply: { error_response: { error_code: 50001 } },
    status: 200,
    code: 'upstream_unavailable',
  },
  { reply: { error_response: { error_code: 52101 } }, status: 200, code: 'rate_limited' },
  {
    reply: { error_response: { error_code: 50001, sub_code: 60001 } },
    status: 200,
    code: 'upstream_rejected',
  },
])('[AC-B1-04h-GOV#7] 真实 convert 端口遇到 $code 只发送一次', async ({ reply, status, code }) => {
  const h = setup(reply, status);
  const port = govern(h.adapter);
  await expect(port.convert(req, identity, ctx)).rejects.toMatchObject({ code, platform: 'pdd' });
  expect(h.transport).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04h-GOV#8] 授权查询接入既有治理层，HTTP 故障按幂等读重试', async () => {
  const h = setup({}, 503);
  const port = govern(h.adapter);
  expect(port.queryPddAuthority).toBeTypeOf('function');
  await expect(port.queryPddAuthority!(identity, ctx)).rejects.toMatchObject({
    code: 'upstream_unavailable',
  });
  expect(h.transport).toHaveBeenCalledTimes(3);
});

it('[AC-B1-04h-GOV#9] 两个授权端口和转链在治理包装后均可到达注入传输', async () => {
  const query = setup({ authority_query_response: { bind: 1 } });
  await expect(govern(query.adapter).queryPddAuthority!(identity, ctx)).resolves.toEqual({
    authorized: true,
  });
  const convert = setup(convertReply());
  await expect(govern(convert.adapter).convert(req, identity, ctx)).resolves.toMatchObject({
    url: mobile,
  });
  const auth = setup(authorityReply());
  const port = govern(auth.adapter);
  expect(port.pddAuthorityUrl).toBeTypeOf('function');
  await expect(port.pddAuthorityUrl!(identity, ctx)).resolves.toMatchObject({ url: mobile });
  for (const h of [query, convert, auth]) {
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.transport.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
  }
});
