import { afterEach, expect, it, vi } from 'vitest';
import {
  DataokeClient,
  type DataokeRandom,
  type DataokeWarning,
} from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import { createUnionRegistry } from '../../../../apps/api/src/modules/union/infra/registry.ts';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import type { TaobaoWarning } from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  DATAOKE_APP_KEY,
  DATAOKE_PATH,
  DATAOKE_SECRET,
  DATAOKE_VERSION,
  TAOBAO_APP_KEY,
  TAOBAO_SECRET,
  clock,
  context,
  dataokeOk,
  expectOrderPortsUnchanged,
  expectedSignRan,
  observeDataoke,
  observeTaobao,
  registryOptions,
} from './kit.ts';

/** A synthetic https gateway the registry must use as given (deployment wires the real one). */
const SYNTHETIC_GATEWAY = 'https://dataoke-wiring.invalid/gateway';
/** The fixed random source value and the nonce it must become (B1-04m). */
const RANDOM_VALUE = 42;
const NONCE = '000042';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function taobaoLiveOptions() {
  const credentials = vi.fn(async () => ({ appKey: TAOBAO_APP_KEY, appSecret: TAOBAO_SECRET }));
  const transport = vi
    .fn<UnionTransport>()
    .mockResolvedValue({ status: 200, headers: {}, body: '{}' });
  const warn = vi.fn<(event: TaobaoWarning) => void>();
  return { credentials, transport, warn };
}

/** In-memory 大淘客 dependencies: a fake transport answering the success envelope. */
function orderSourceOptions() {
  const credentials = vi.fn(async () => ({ appKey: DATAOKE_APP_KEY, appSecret: DATAOKE_SECRET }));
  const transport = vi
    .fn<UnionTransport>()
    .mockResolvedValue({ status: 200, headers: {}, body: dataokeOk() });
  const random = vi.fn<DataokeRandom>().mockReturnValue(RANDOM_VALUE);
  const warn = vi.fn<(event: DataokeWarning) => void>();
  return { credentials, transport, random, baseUrl: SYNTHETIC_GATEWAY, warn };
}

it('[AC-B1-04e#19] taobaoLive.orderSource 装配一个大淘客客户端（凭据/传输/随机源/网关/warn + 注册表时钟），作为淘宝适配器的 orderSource', async () => {
  const taobaoObserved = observeTaobao();
  const dataokeObserved = observeDataoke();
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  const taobaoLive = taobaoLiveOptions();
  const orderSource = orderSourceOptions();
  const registry = createUnionRegistry({
    ...registryOptions(),
    taobaoLive: { ...taobaoLive, orderSource },
  });
  expect(dataokeObserved.constructor).toHaveBeenCalledTimes(1);
  const supplied = dataokeObserved.constructor.mock.calls[0]![0];
  expect(supplied.baseUrl).toBe(SYNTHETIC_GATEWAY);
  expect(supplied.clock).toBe(clock);
  expect(supplied.transport).toBe(orderSource.transport);
  expect(supplied.transport).not.toBe(taobaoLive.transport);
  expect(supplied.random).toBe(orderSource.random);
  expect(supplied.warn).toBe(orderSource.warn);
  // Credentials are not fetched while assembling, only per request.
  expect(orderSource.credentials).not.toHaveBeenCalled();
  await expect(supplied.credentials()).resolves.toEqual({
    appKey: DATAOKE_APP_KEY,
    appSecret: DATAOKE_SECRET,
  });
  expect(taobaoObserved.constructor).toHaveBeenCalledTimes(1);
  const adapterOptions = taobaoObserved.constructor.mock.calls[0]![0];
  expect(adapterOptions.orderSource).toBe(dataokeObserved.constructor.mock.results[0]!.value);
  expect(adapterOptions.orderSource).toBeInstanceOf(dataokeObserved.Original);
  expect(adapterOptions.transport).toBe(taobaoLive.transport);
  await expect(adapterOptions.credentials()).resolves.toEqual({
    appKey: TAOBAO_APP_KEY,
    appSecret: TAOBAO_SECRET,
  });
  expect(registry.get('taobao')).toBe(taobaoObserved.constructor.mock.results[0]!.value);
  expect(registry.registrations().find((entry) => entry.platform === 'taobao')?.implemented).toBe(
    true,
  );
  expect(orderSource.transport).not.toHaveBeenCalled();
  expect(orderSource.random).not.toHaveBeenCalled();
  expect(taobaoLive.transport).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});

it('[AC-B1-04e#20] 没有 orderSource 时淘宝适配器不带大淘客客户端、订单端口行为不变；给出 orderSource 才注入', async () => {
  const taobaoObserved = observeTaobao();
  const dataokeObserved = observeDataoke();
  const plain = createUnionRegistry({ ...registryOptions(), taobaoLive: taobaoLiveOptions() });
  expect(dataokeObserved.constructor).not.toHaveBeenCalled();
  expect(taobaoObserved.constructor).toHaveBeenCalledTimes(1);
  expect(taobaoObserved.constructor.mock.calls[0]![0].orderSource).toBeUndefined();
  await expectOrderPortsUnchanged(plain.get('taobao'));

  const orderSource = orderSourceOptions();
  const injected = createUnionRegistry({
    ...registryOptions(),
    taobaoLive: { ...taobaoLiveOptions(), orderSource },
  });
  expect(dataokeObserved.constructor).toHaveBeenCalledTimes(1);
  expect(taobaoObserved.constructor).toHaveBeenCalledTimes(2);
  expect(taobaoObserved.constructor.mock.calls[1]![0].orderSource).toBe(
    dataokeObserved.constructor.mock.results[0]!.value,
  );
  expect(injected.get('taobao')).toBe(taobaoObserved.constructor.mock.results[1]!.value);
  expect(orderSource.transport).not.toHaveBeenCalled();
});

it.each(['replay', 'demo'] as const)(
  '[AC-B1-04e#21] 相同 orderSource 只在 taobao live 装配：taobao=%s 不构造大淘客客户端、不取凭据、不发请求',
  async (mode) => {
    const dataokeObserved = observeDataoke();
    const orderSource = orderSourceOptions();
    const options = { ...registryOptions(), taobaoLive: { ...taobaoLiveOptions(), orderSource } };
    const dormant = createUnionRegistry({ ...options, ...registryOptions(mode) });
    if (mode === 'replay') {
      await expect(
        dormant.get('taobao').searchItems({ keyword: '演示' }, context),
      ).rejects.toMatchObject({ code: 'adapter_unimplemented' });
    } else {
      const page = await dormant.get('taobao').searchItems({ keyword: '演示' }, context);
      expect(page.items.length).toBeGreaterThan(0);
    }
    expect(dataokeObserved.constructor).not.toHaveBeenCalled();
    expect(orderSource.credentials).not.toHaveBeenCalled();
    expect(orderSource.transport).not.toHaveBeenCalled();
    expect(orderSource.random).not.toHaveBeenCalled();
    // Same options become effective only with mode=live; guards against ignoring orderSource.
    createUnionRegistry(options);
    expect(dataokeObserved.constructor).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-04e#22] 端到端（内存假传输）：适配器持有的大淘客客户端请求发往给定网关，appKey 取凭据值，signRan 按 B1-04m 规则，请求不含 secret', async () => {
  const taobaoObserved = observeTaobao();
  const taobaoLive = taobaoLiveOptions();
  const orderSource = orderSourceOptions();
  const registry = createUnionRegistry({
    ...registryOptions(),
    taobaoLive: { ...taobaoLive, orderSource },
  });
  expect(taobaoObserved.constructor).toHaveBeenCalledTimes(1);
  expect(registry.get('taobao')).toBe(taobaoObserved.constructor.mock.results[0]!.value);
  const held = taobaoObserved.constructor.mock.calls[0]![0].orderSource;
  expect(held).toBeInstanceOf(DataokeClient);
  const client = held as DataokeClient;
  const archive = { appId: context.appId, kind: 'order' };
  await expect(
    client.request('GET', DATAOKE_PATH, { pageSize: 2 }, { version: DATAOKE_VERSION, archive }),
  ).resolves.toEqual({ result: 'synthetic' });
  expect(orderSource.transport).toHaveBeenCalledTimes(1);
  const request = orderSource.transport.mock.calls[0]![0];
  expect(request.platform).toBe('taobao');
  expect(request.method).toBe('GET');
  expect(request.archive).toEqual(archive);
  const url = new URL(request.url);
  expect(`${url.origin}${url.pathname}`).toBe(`${SYNTHETIC_GATEWAY}${DATAOKE_PATH}`);
  const timer = String(clock.now().getTime());
  expect(url.searchParams.get('appKey')).toBe(DATAOKE_APP_KEY);
  expect(url.searchParams.get('version')).toBe(DATAOKE_VERSION);
  expect(url.searchParams.get('timer')).toBe(timer);
  expect(url.searchParams.get('nonce')).toBe(NONCE);
  expect(url.searchParams.get('pageSize')).toBe('2');
  expect(url.searchParams.get('signRan')).toBe(
    expectedSignRan(DATAOKE_APP_KEY, timer, NONCE, DATAOKE_SECRET),
  );
  expect(orderSource.random).toHaveBeenCalledExactlyOnceWith(1_000_000);
  expect(orderSource.credentials).toHaveBeenCalledTimes(1);
  for (const part of [request.url, JSON.stringify(request.headers), request.body ?? '']) {
    expect(part).not.toContain(DATAOKE_SECRET);
  }
  // The taobao pair and transport are not touched by an order-source request.
  expect(taobaoLive.transport).not.toHaveBeenCalled();
  expect(taobaoLive.credentials).not.toHaveBeenCalled();
});
