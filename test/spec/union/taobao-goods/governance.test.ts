import { expect, it, vi } from 'vitest';
import {
  FixedClock,
  type QuotaLimiter,
  type Scheduler,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createGovernedAdapter,
  createUnionRegistry,
  UnionError,
  type CallCtx,
  type TaobaoShareCode,
  type UnionAdapter,
  type UnionErrorCode,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  ctx,
  DETAIL,
  detailBody,
  detailRow,
  endpoint,
  errorBody,
  instant,
  ref,
  registryEndpoints,
  setup,
  SHARE_MODEL,
  SHARE_PASSWORD,
  shareBody,
  shareData,
  SHORT_LINK,
  SPREAD,
  spreadBody,
  TPWD,
  withStatus,
} from './kit.ts';

// 注入固定调度器：退避立即结束，超时只等待取消；不读宿主时钟、不监听端口。
const scheduler: Scheduler = {
  now: () => 0,
  sleep: (ms, signal) =>
    ms < 3000
      ? Promise.resolve()
      : new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
};

const LINK = 'https://s.click.taobao.com/t?e=synthetic-governed';
const share: TaobaoShareCode = { password_simple: SHARE_PASSWORD, model: SHARE_MODEL };
const SPREAD_OK = spreadBody([{ content: SHORT_LINK, err_msg: 'OK' }]);

type Port = 'taobaoShareCode' | 'shortenTaobaoUrl';
type PortFn = (url: string, call: CallCtx) => Promise<unknown>;
type ShareFn = NonNullable<UnionAdapter['taobaoShareCode']>;
type ShortenFn = NonNullable<UnionAdapter['shortenTaobaoUrl']>;
const ports: readonly Port[] = ['taobaoShareCode', 'shortenTaobaoUrl'];

function govern(raw: UnionAdapter, take: QuotaLimiter['tryAcquire'] = () => true) {
  return createGovernedAdapter(raw, {
    endpoint,
    scheduler,
    quota: { bucketKey: endpoint.quotaKey, tryAcquire: take },
  });
}

function basicAdapter(): UnionAdapter {
  return {
    platform: 'taobao',
    searchItems: async () => ({ items: [], nextCursor: null }),
    getItem: async () => {
      throw new Error('unused synthetic port');
    },
    resolveLink: async () => ({ item: ref }),
    convert: async () => ({ kind: 'url', url: LINK }),
    listOrders: async () => ({ items: [], nextCursor: null }),
  };
}

/** Puts `run` on a basic adapter as the given optional port. */
function offer(raw: UnionAdapter, port: Port, run: PortFn): UnionAdapter {
  if (port === 'taobaoShareCode') raw.taobaoShareCode = run as ShareFn;
  else raw.shortenTaobaoUrl = run as ShortenFn;
  return raw;
}

function callPort(adapter: UnionAdapter, port: Port, call: CallCtx = ctx): Promise<unknown> {
  if (port === 'taobaoShareCode') {
    expect(adapter.taobaoShareCode, 'taobaoShareCode is offered').toBeTypeOf('function');
    return adapter.taobaoShareCode!(LINK, call);
  }
  expect(adapter.shortenTaobaoUrl, 'shortenTaobaoUrl is offered').toBeTypeOf('function');
  return adapter.shortenTaobaoUrl!(LINK, call);
}

function cases(codes: readonly UnionErrorCode[]): [Port, UnionErrorCode][] {
  return ports.flatMap((port) => codes.map((code): [Port, UnionErrorCode] => [port, code]));
}

it('[AC-B1-04l#32] 两个新端口有能力才出现；缺省的适配器与 demo 淘宝适配器都不出现', () => {
  const raw = basicAdapter();
  raw.taobaoShareCode = async () => share;
  raw.shortenTaobaoUrl = async () => SHORT_LINK;
  const governed = govern(raw);
  expect(governed.taobaoShareCode).toBeTypeOf('function');
  expect(governed.shortenTaobaoUrl).toBeTypeOf('function');
  const bare = govern(basicAdapter());
  expect(bare.taobaoShareCode).toBeUndefined();
  expect(bare.shortenTaobaoUrl).toBeUndefined();
  const registry = createUnionRegistry({
    endpoints: registryEndpoints('demo'),
    environment: 'staging',
    seed: 'synthetic-goods-demo',
    clock: new FixedClock(instant),
  });
  const demo = registry.get('taobao');
  expect(demo.taobaoShareCode).toBeUndefined();
  expect(demo.shortenTaobaoUrl).toBeUndefined();
  expect(govern(demo).taobaoShareCode).toBeUndefined();
  expect(govern(demo).shortenTaobaoUrl).toBeUndefined();
});

it.each(cases(['upstream_unavailable', 'rate_limited']))(
  '[AC-B1-04l#33] %s 遇 %s 按幂等读重试两次，每次按调用 purpose 扣配额',
  async (port, code) => {
    const run = vi.fn(async () => {
      throw new UnionError(code, 'synthetic failure', 'taobao');
    });
    const take = vi.fn<QuotaLimiter['tryAcquire']>(() => true);
    const governed = govern(offer(basicAdapter(), port, run), take);
    await expect(callPort(governed, port)).rejects.toMatchObject({ code });
    expect(run).toHaveBeenCalledTimes(3);
    expect(take.mock.calls).toEqual([['online'], ['online'], ['online']]);
  },
);

it.each(ports)(
  '[AC-B1-04l#34] %s 重试后成功：绑定原适配器、url 原样、上下文用配置的 baseUrl 并注入 signal',
  async (port) => {
    const raw = basicAdapter();
    const contexts: CallCtx[] = [];
    const urls: string[] = [];
    const answer = port === 'taobaoShareCode' ? share : SHORT_LINK;
    const limit = new UnionError('rate_limited', 'synthetic limit', 'taobao');
    const run = vi.fn(async function (this: unknown, url: string, call: CallCtx) {
      expect(this).toBe(raw);
      urls.push(url);
      contexts.push(call);
      if (contexts.length === 1) throw limit;
      return answer;
    });
    offer(raw, port, run);
    const caller = Object.freeze({
      ...ctx,
      baseUrl: 'https://untrusted.invalid',
      headers: { injected: 'no' },
    });
    expect(await callPort(govern(raw), port, caller)).toBe(answer);
    expect(urls).toEqual([LINK, LINK]);
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
    expect(caller).not.toHaveProperty('signal');
  },
);

it.each(cases(['invalid_dto', 'link_unrecognized', 'upstream_rejected']))(
  '[AC-B1-04l#35] %s 的业务拒绝 %s 不重试',
  async (port, code) => {
    const run = vi.fn(async () => {
      throw new UnionError(code, 'synthetic rejection', 'taobao');
    });
    const governed = govern(offer(basicAdapter(), port, run));
    await expect(callPort(governed, port)).rejects.toMatchObject({ code });
    expect(run).toHaveBeenCalledTimes(1);
  },
);

it.each(ports)('[AC-B1-04l#36] %s 配额不足时不访问上游', async (port) => {
  const run = vi.fn(async () => SHORT_LINK);
  const governed = govern(offer(basicAdapter(), port, run), () => false);
  await expect(callPort(governed, port)).rejects.toMatchObject({ code: 'quota_exceeded' });
  expect(run).not.toHaveBeenCalled();
});

function realGateway() {
  return setup((form) => {
    if (form['method'] === DETAIL) return detailBody([detailRow()]);
    if (form['method'] === TPWD) return shareBody(shareData());
    if (form['method'] === SPREAD) return SPREAD_OK;
    return errorBody('synthetic-unexpected-method');
  });
}

it('[AC-B1-04l#37] 真实淘宝适配器经治理包装后：详情与两个新端口都到达注入传输，各发一次并带 signal', async () => {
  const detail = realGateway();
  expect(await govern(detail.adapter).getItem(ref, ctx)).toMatchObject({
    platform: 'taobao',
    final_price_fen: 4990n,
  });
  const code = realGateway();
  expect(await callPort(govern(code.adapter), 'taobaoShareCode')).toEqual(share);
  const short = realGateway();
  expect(await callPort(govern(short.adapter), 'shortenTaobaoUrl')).toBe(SHORT_LINK);
  for (const h of [detail, code, short]) {
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(h.transport.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
  }
});

interface DetailCase {
  readonly name: string;
  readonly answer: unknown;
  readonly code: UnionErrorCode;
  readonly sends: number;
}

const governedDetail: readonly DetailCase[] = [
  {
    name: '15/50001（业务拒绝，不重试）',
    answer: errorBody(15, '50001'),
    code: 'item_unavailable',
    sends: 1,
  },
  {
    name: '15/1911（业务拒绝，不重试）',
    answer: errorBody(15, '1911'),
    code: 'upstream_rejected',
    sends: 1,
  },
  {
    name: 'HTTP 503（依赖故障，重试两次）',
    answer: withStatus(503, 'synthetic outage'),
    code: 'upstream_unavailable',
    sends: 3,
  },
];

it.each(governedDetail)('[AC-B1-04l#38] 治理后的详情 $name 得 $code', async (row) => {
  const h = setup(() => row.answer);
  await expect(govern(h.adapter).getItem(ref, ctx)).rejects.toMatchObject({
    code: row.code,
    platform: 'taobao',
  });
  expect(h.transport).toHaveBeenCalledTimes(row.sends);
});
