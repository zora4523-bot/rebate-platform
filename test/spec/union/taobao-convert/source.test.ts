import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { UnionEndpoint } from '../../../../apps/api/src/modules/union/domain/types.ts';
import type {
  DataokeCredentials,
  DataokeRandom,
} from '../../../../apps/api/src/modules/union/infra/dataoke/dataoke-client.ts';
import { createUnionRegistry } from '../../../../apps/api/src/modules/union/infra/registry.ts';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import type {
  TaobaoConvertSource,
  TaobaoCredentials,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  converted,
  ctx,
  DATAOKE_APP_KEY,
  DATAOKE_SECRET,
  endpoint,
  envelope,
  expectNothingSent,
  GOODS_ID,
  identity,
  PRIVILEGE_PATH,
  PRIVILEGE_VERSION,
  RELATION_ID,
  req,
  response,
  SELF_SLOT,
  setup,
  SHORT_URL,
  TAOBAO_APP_KEY,
  TAOBAO_SECRET,
  unionFailure,
} from './kit.ts';

// 数据源开关（官方万能转链批下前可配置切换）：只有 convertSource='dataoke' 且注入了大淘客客户端时
// 才经大淘客转链；其余情况淘宝 convert 与 B1-04d 之前完全一样（adapter_unimplemented，什么都不取不发）。

it.each(['absent', 'baichuan'] as const)(
  '[AC-B1-04d#26] 有大淘客客户端但开关 %s → convert 行为不变（adapter_unimplemented，不取凭据、不发请求）；开关 dataoke 才转链',
  async (convertSource) => {
    const off = setup({ convertSource });
    await unionFailure(() => off.adapter.convert(req, identity, ctx), 'adapter_unimplemented');
    expectNothingSent(off);

    const on = setup({ convertSource: 'dataoke' });
    const result = await converted(() => on.adapter.convert(req, identity, ctx));
    expect(result.url).toBe(SHORT_URL);
    expect(on.dataokeTransport).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-04d#27] 开关 dataoke 但没有注入大淘客客户端 → convert 行为不变（adapter_unimplemented，不取不发）；注入后才转链', async () => {
  const bare = setup({ withSource: false, convertSource: 'dataoke' });
  await unionFailure(() => bare.adapter.convert(req, identity, ctx), 'adapter_unimplemented');
  expectNothingSent(bare);

  const wired = setup({ withSource: true, convertSource: 'dataoke' });
  await converted(() => wired.adapter.convert(req, identity, ctx));
  expect(wired.dataokeTransport).toHaveBeenCalledTimes(1);
  expect(wired.taobaoTransport).not.toHaveBeenCalled();
});

it('[AC-B1-04d#28] 开关只影响 convert：getItem / 淘口令 / 短链仍走淘宝 TOP 网关，不经大淘客', async () => {
  const h = setup({ convertSource: 'dataoke' });
  h.taobaoTransport.mockResolvedValue(response({ error_response: { code: 15, sub_code: 'x' } }));
  await expect(
    h.adapter.shortenTaobaoUrl('https://uland.taobao.com/synthetic', ctx),
  ).rejects.toMatchObject({ code: 'upstream_rejected' });
  expect(h.taobaoTransport).toHaveBeenCalledTimes(1);
  expect(h.dataokeTransport).not.toHaveBeenCalled();

  await converted(() => h.adapter.convert(req, identity, ctx));
  expect(h.dataokeTransport).toHaveBeenCalledTimes(1);
  expect(h.taobaoTransport).toHaveBeenCalledTimes(1);
});

// ---- registry ---------------------------------------------------------------------------------

const REGISTRY_GATEWAY = 'https://dataoke-convert-registry.invalid/gateway';
const registryClock = new FixedClock('2026-11-01T03:00:00.000Z');

function endpoints(): readonly UnionEndpoint[] {
  return [
    { platform: 'jd', mode: 'live', baseUrl: 'https://jd.invalid/router', quotaKey: 'fake:jd' },
    {
      platform: 'pdd',
      mode: 'replay',
      baseUrl: 'https://pdd.invalid/router',
      quotaKey: 'fake:pdd',
    },
    endpoint,
  ];
}

function registryParts() {
  const taobao = {
    credentials: vi.fn<() => Promise<TaobaoCredentials>>(async () => ({
      appKey: TAOBAO_APP_KEY,
      appSecret: TAOBAO_SECRET,
    })),
    transport: vi.fn<UnionTransport>(async () => response({})),
  };
  const orderSource = {
    credentials: vi.fn<() => Promise<DataokeCredentials>>(async () => ({
      appKey: DATAOKE_APP_KEY,
      appSecret: DATAOKE_SECRET,
    })),
    transport: vi.fn<UnionTransport>(async () => response(envelope())),
    random: vi.fn<DataokeRandom>().mockReturnValue(42),
    baseUrl: REGISTRY_GATEWAY,
  };
  return { taobao, orderSource };
}

function registryWith(convertSource: TaobaoConvertSource | 'absent', withSource = true) {
  const parts = registryParts();
  const registry = createUnionRegistry({
    endpoints: endpoints(),
    environment: 'staging',
    seed: 'fake-taobao-convert',
    clock: registryClock,
    taobaoLive: {
      ...parts.taobao,
      ...(withSource ? { orderSource: parts.orderSource } : {}),
      ...(convertSource === 'absent' ? {} : { convertSource }),
    },
  });
  return { registry, ...parts };
}

it('[AC-B1-04d#29] 注册表 taobaoLive.convertSource=dataoke + orderSource：淘宝 convert 经该网关的 get-privilege-link 转链', async () => {
  const { registry, taobao, orderSource } = registryWith('dataoke');
  const result = await converted(() => registry.get('taobao').convert(req, identity, ctx));
  expect(result.url).toBe(SHORT_URL);
  expect(orderSource.transport).toHaveBeenCalledTimes(1);
  const request = orderSource.transport.mock.calls[0]![0];
  expect(request.method).toBe('GET');
  const url = new URL(request.url);
  expect(`${url.origin}${url.pathname}`).toBe(`${REGISTRY_GATEWAY}${PRIVILEGE_PATH}`);
  expect(url.searchParams.get('version')).toBe(PRIVILEGE_VERSION);
  expect(url.searchParams.get('goodsId')).toBe(GOODS_ID);
  expect(url.searchParams.get('pid')).toBe(SELF_SLOT);
  expect(url.searchParams.get('channelId')).toBe(RELATION_ID);
  expect(request.archive).toEqual({ appId: ctx.appId, kind: 'convert' });
  expect(taobao.transport).not.toHaveBeenCalled();
  expect(taobao.credentials).not.toHaveBeenCalled();
});

it.each([
  ['convertSource absent', 'absent', true],
  ['convertSource baichuan', 'baichuan', true],
  ['convertSource dataoke without orderSource', 'dataoke', false],
] as [string, TaobaoConvertSource | 'absent', boolean][])(
  '[AC-B1-04d#30] 注册表 %s → 淘宝 convert 行为不变（adapter_unimplemented，不取不发）',
  async (_label, convertSource, withSource) => {
    const off = registryWith(convertSource, withSource);
    await unionFailure(
      () => off.registry.get('taobao').convert(req, identity, ctx),
      'adapter_unimplemented',
    );
    expect(off.orderSource.transport).not.toHaveBeenCalled();
    expect(off.orderSource.credentials).not.toHaveBeenCalled();
    expect(off.taobao.transport).not.toHaveBeenCalled();
    expect(off.taobao.credentials).not.toHaveBeenCalled();

    // 对照：同样的部件把开关打开就转链（排除开关被忽略）。
    const on = registryWith('dataoke');
    await converted(() => on.registry.get('taobao').convert(req, identity, ctx));
    expect(on.orderSource.transport).toHaveBeenCalledTimes(1);
  },
);
