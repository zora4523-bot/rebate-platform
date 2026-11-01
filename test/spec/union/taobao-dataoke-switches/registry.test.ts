import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  UnionAdapter,
  UnionMode,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import type { DataokeRandom } from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import {
  createUnionRegistry,
  type TaobaoLiveOptions,
} from '../../../../apps/api/src/modules/union/infra/registry.ts';
import type {
  TaobaoOrderSlotReader,
  TaobaoOrderWarning,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  ctx as convertCtx,
  identity as convertIdentity,
  req as convertReq,
} from '../taobao-convert/kit.ts';
import {
  FOREIGN_ADZONE,
  OUR_ADZONE,
  OUR_SLOT,
  RETIRED_ADZONE,
  RETIRED_SLOT,
  rowOf,
  win,
} from '../taobao-orders/kit.ts';
import { couliItemId, query as searchQuery } from '../taobao-search/kit.ts';
import {
  DATAOKE_APP_KEY,
  DATAOKE_SECRET,
  SYNTHETIC_GATEWAY,
  TAOBAO_APP_KEY,
  TAOBAO_SECRET,
  clock,
  ctx,
  dataokePaths,
  endpoints,
  fakeUpstream,
  observeTaobao,
  refused,
  succeeded,
  type Upstream,
} from './kit.ts';

// D10-530 registry part: taobaoLive's optional searchSource / orderSlots / orderWarn (next to the
// B1-04d convertSource) are handed to TaobaoUnionAdapter as they are; without them the adapter
// options stay as before. Only a taobao endpoint with mode=live takes them.

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => expect.fail('network access is forbidden')),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function registryOptions(mode: UnionMode = 'live') {
  return { endpoints: endpoints(mode), environment: 'staging' as const, seed: 'switches', clock };
}

/** taobaoLive over the in-memory upstream, with the 大淘客 order source, plus `extra`. */
function live(upstream: Upstream, extra: Partial<TaobaoLiveOptions> = {}): TaobaoLiveOptions {
  return {
    credentials: async () => ({ appKey: TAOBAO_APP_KEY, appSecret: TAOBAO_SECRET }),
    transport: upstream.topTransport,
    orderSource: {
      credentials: async () => ({ appKey: DATAOKE_APP_KEY, appSecret: DATAOKE_SECRET }),
      transport: upstream.dataokeTransport,
      random: vi.fn<DataokeRandom>().mockReturnValue(42),
      baseUrl: SYNTHETIC_GATEWAY,
    },
    ...extra,
  };
}

it('[AC-B1-04zn#6] taobaoLive 的 searchSource / orderSlots / orderWarn 原样交给淘宝适配器；不传时适配器选项里没有这三项', () => {
  const observed = observeTaobao();
  const upstream = fakeUpstream();
  createUnionRegistry({ ...registryOptions(), taobaoLive: live(upstream) });
  expect(observed).toHaveBeenCalledTimes(1);
  const plain = observed.mock.calls[0]![0];
  for (const key of ['searchSource', 'orderSlots', 'orderWarn', 'convertSource']) {
    expect(Object.hasOwn(plain, key), `${key} absent`).toBe(false);
  }

  const orderSlots = vi.fn<TaobaoOrderSlotReader>(async () => [OUR_SLOT]);
  const orderWarn = vi.fn<(event: TaobaoOrderWarning) => void>();
  for (const searchSource of ['dataoke', 'official'] as const) {
    observed.mockClear();
    createUnionRegistry({
      ...registryOptions(),
      taobaoLive: live(upstream, {
        searchSource,
        convertSource: 'dataoke',
        orderSlots,
        orderWarn,
      }),
    });
    expect(observed).toHaveBeenCalledTimes(1);
    const options = observed.mock.calls[0]![0];
    expect(options.searchSource).toBe(searchSource);
    expect(options.convertSource).toBe('dataoke');
    expect(options.orderSlots).toBe(orderSlots);
    expect(options.orderWarn).toBe(orderWarn);
  }
  // Assembling reads nothing and sends nothing.
  expect(orderSlots).not.toHaveBeenCalled();
  expect(orderWarn).not.toHaveBeenCalled();
  expect(upstream.dataokeTransport).not.toHaveBeenCalled();
  expect(upstream.topTransport).not.toHaveBeenCalled();
});

it.each(['replay', 'demo'] as const)(
  '[AC-B1-04zn#7] taobao=%s 不构造真实淘宝适配器、不调推广位读者；同样的选项切 live 才交给适配器',
  async (mode) => {
    const observed = observeTaobao();
    const upstream = fakeUpstream();
    const orderSlots = vi.fn<TaobaoOrderSlotReader>(async () => [OUR_SLOT]);
    const orderWarn = vi.fn<(event: TaobaoOrderWarning) => void>();
    const taobaoLive = live(upstream, { searchSource: 'dataoke', orderSlots, orderWarn });
    const dormant = createUnionRegistry({ ...registryOptions(mode), taobaoLive });
    expect(observed).not.toHaveBeenCalled();
    await outcomeOfOrders(dormant.get('taobao'));
    expect(orderSlots).not.toHaveBeenCalled();
    expect(upstream.dataokeTransport).not.toHaveBeenCalled();

    createUnionRegistry({ ...registryOptions(), taobaoLive });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed.mock.calls[0]![0].searchSource).toBe('dataoke');
    expect(observed.mock.calls[0]![0].orderSlots).toBe(orderSlots);
  },
);

/** Calls listOrders on a dormant adapter; whatever it answers, it must not reach the reader. */
async function outcomeOfOrders(adapter: UnionAdapter): Promise<void> {
  try {
    await adapter.listOrders(win, {}, ctx);
  } catch {
    // demo answers synthetic orders, replay refuses: both are fine here.
  }
}

it('[AC-B1-04zn#8] 端到端（内存假传输）：searchSource=dataoke 时经注册表拿到的适配器去大淘客搜索；official / 缺省仍 adapter_unimplemented 且不发请求', async () => {
  for (const searchSource of [undefined, 'official'] as const) {
    const upstream = fakeUpstream();
    const registry = createUnionRegistry({
      ...registryOptions(),
      taobaoLive: live(upstream, searchSource === undefined ? {} : { searchSource }),
    });
    await refused(
      () => registry.get('taobao').searchItems(searchQuery, ctx),
      'adapter_unimplemented',
    );
    expect(upstream.dataokeTransport).not.toHaveBeenCalled();
    expect(upstream.topTransport).not.toHaveBeenCalled();
  }

  const upstream = fakeUpstream();
  const registry = createUnionRegistry({
    ...registryOptions(),
    taobaoLive: live(upstream, { searchSource: 'dataoke' }),
  });
  const page = await succeeded(
    () => registry.get('taobao').searchItems(searchQuery, ctx),
    'searchItems',
  );
  expect(dataokePaths(upstream)).toEqual(['/api/goods/get-dtk-search-goods']);
  expect(new URL(upstream.dataokeTransport.mock.calls[0]![0].url).origin).toBe(SYNTHETIC_GATEWAY);
  expect(page.items.map((item) => item.item_id)).toEqual([couliItemId(1), couliItemId(2)]);
  // Without the 大淘客 order source the same switch changes nothing.
  const bare = fakeUpstream();
  const { orderSource: _unused, ...withoutSource } = live(bare, { searchSource: 'dataoke' });
  void _unused;
  const sourceless = createUnionRegistry({ ...registryOptions(), taobaoLive: withoutSource });
  await refused(
    () => sourceless.get('taobao').searchItems(searchQuery, ctx),
    'adapter_unimplemented',
  );
  expect(bare.dataokeTransport).not.toHaveBeenCalled();
  expect(bare.topTransport).not.toHaveBeenCalled();
});

it('[AC-B1-04zn#9] 端到端（内存假传输 + 假读者）：给了 orderSlots 后 listOrders 只留读者给出的推广位（含已停用）的订单，别家的只计数告警', async () => {
  const upstream = fakeUpstream({
    orders: [rowOf(1, OUR_ADZONE), rowOf(2, FOREIGN_ADZONE), rowOf(3, RETIRED_ADZONE)],
  });
  const orderSlots = vi.fn<TaobaoOrderSlotReader>(async () => [OUR_SLOT, RETIRED_SLOT]);
  const orderWarn = vi.fn<(event: TaobaoOrderWarning) => void>();
  const registry = createUnionRegistry({
    ...registryOptions(),
    taobaoLive: live(upstream, { orderSlots, orderWarn }),
  });
  const page = await succeeded(() => registry.get('taobao').listOrders(win, {}, ctx), 'listOrders');
  expect(page.items.map((order) => order.order_id)).toEqual([rowOf(1).trade_id, rowOf(3).trade_id]);
  expect(orderSlots).toHaveBeenCalledTimes(1);
  expect(orderSlots.mock.calls[0]![0]).toMatchObject({ appId: ctx.appId });
  expect(dataokePaths(upstream)).toEqual(['/api/tb-service/get-order-details']);
  expect(orderWarn).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'taobao_order_foreign_slot', count: 1 }),
  );
  expect(upstream.topTransport).not.toHaveBeenCalled();
});

it('[AC-B1-04zn#10] 转链开关与新开关并存：convertSource=dataoke 且同时给了 searchSource / orderSlots 时，convert 仍经大淘客转链', async () => {
  const upstream = fakeUpstream();
  const orderSlots = vi.fn<TaobaoOrderSlotReader>(async () => [OUR_SLOT]);
  const observed = observeTaobao();
  const registry = createUnionRegistry({
    ...registryOptions(),
    taobaoLive: live(upstream, { convertSource: 'dataoke', searchSource: 'dataoke', orderSlots }),
  });
  expect(observed.mock.calls[0]![0].searchSource).toBe('dataoke');
  const result = await succeeded(
    () => registry.get('taobao').convert(convertReq, convertIdentity, convertCtx),
    'convert',
  );
  expect(result.kind).toBe('url');
  expect(dataokePaths(upstream)).toEqual(['/api/tb-service/get-privilege-link']);
  expect(orderSlots).not.toHaveBeenCalled();
});
