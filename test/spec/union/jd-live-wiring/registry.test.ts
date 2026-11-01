import { afterEach, expect, it, vi } from 'vitest';
import {
  JdUnionAdapter,
  type JdWarning,
} from '../../../../apps/api/src/modules/union/infra/jd/jd-adapter.ts';
import type { JdProductKeyMode } from '../../../../apps/api/src/modules/union/infra/jd/orders.ts';
import { PddUnionAdapter } from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';
import { createUnionRegistry } from '../../../../apps/api/src/modules/union/infra/registry.ts';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { TaobaoUnionAdapter } from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  APP_KEY,
  PDD_CLIENT_ID,
  PDD_SECRET,
  SECRET,
  TAOBAO_APP_KEY,
  TAOBAO_SECRET,
  clock,
  context,
  endpoints,
  observeJd,
  registryOptions,
} from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fakeTransport() {
  return vi.fn<UnionTransport>().mockResolvedValue({ status: 200, headers: {}, body: '{}' });
}

function liveOptions() {
  const credentials = vi.fn(async () => ({ appKey: APP_KEY, appSecret: SECRET }));
  const transport = fakeTransport();
  const warn = vi.fn<(event: JdWarning) => void>();
  const productKeyMode = { read: vi.fn(async (): Promise<JdProductKeyMode> => 'sku') };
  // Extra structural option is intentional: existing exports suffice for an assertion-red test.
  // Implementation must add the typed jdLive option (symmetric to taobaoLive).
  return { ...registryOptions(), jdLive: { credentials, transport, warn, productKeyMode } };
}

it('[AC-B1-04ze#34] 显式 jdLive 装配真实适配器，注入凭据/传输/时钟/端点/warn/商品键模式，注册表直接返回该适配器', async () => {
  const observed = observeJd();
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  const options = liveOptions();
  const registry = createUnionRegistry(options);
  expect(registry.registrations()).toEqual([
    { platform: 'jd', implemented: true },
    { platform: 'pdd', implemented: false },
    { platform: 'taobao', implemented: false },
  ]);
  expect(observed.constructor).toHaveBeenCalledTimes(1);
  const supplied = observed.constructor.mock.calls[0]![0];
  expect(supplied.endpoint).toEqual(options.endpoints.find((entry) => entry.platform === 'jd'));
  expect(supplied.clock).toBe(clock);
  expect(supplied.transport).toBe(options.jdLive.transport);
  expect(supplied.warn).toBe(options.jdLive.warn);
  expect(supplied.productKeyMode).toBe(options.jdLive.productKeyMode);
  expect(supplied.credentials).toBeTypeOf('function');
  await expect(supplied.credentials()).resolves.toEqual({ appKey: APP_KEY, appSecret: SECRET });
  expect(options.jdLive.credentials).toHaveBeenCalledTimes(1);
  expect(registry.get('jd')).toBe(observed.constructor.mock.results[0]!.value);
  expect(registry.get('jd')).toBeInstanceOf(JdUnionAdapter);
  for (const platform of ['pdd', 'taobao'] as const) {
    await expect(
      registry.get(platform).searchItems({ keyword: 'synthetic' }, context),
    ).rejects.toMatchObject({ code: 'adapter_unimplemented' });
  }
  expect(options.jdLive.productKeyMode.read).not.toHaveBeenCalled();
  expect(options.jdLive.transport).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});

it('[AC-B1-04ze#35] jdLive 只给凭据与传输也能装配，商品键模式与 warn 不凭空出现', () => {
  const observed = observeJd();
  const credentials = vi.fn(async () => ({ appKey: APP_KEY, appSecret: SECRET }));
  const options = { ...registryOptions(), jdLive: { credentials, transport: fakeTransport() } };
  const registry = createUnionRegistry(options);
  expect(registry.get('jd')).toBeInstanceOf(JdUnionAdapter);
  expect(observed.constructor).toHaveBeenCalledTimes(1);
  const supplied = observed.constructor.mock.calls[0]![0];
  expect(supplied.productKeyMode).toBeUndefined();
  expect(supplied.warn).toBeUndefined();
  expect(credentials).not.toHaveBeenCalled();
});

it.each(['replay', 'demo'] as const)(
  '[AC-B1-04ze#36] 相同显式凭据只在 live 装配：jd=%s 不构造真实适配器、不取凭据、不联网',
  async (mode) => {
    const observed = observeJd();
    const options = liveOptions();
    const dormant = createUnionRegistry({ ...options, ...registryOptions(mode) });
    expect(dormant.registrations().find((entry) => entry.platform === 'jd')?.implemented).toBe(
      mode === 'demo',
    );
    if (mode === 'replay') {
      await expect(
        dormant.get('jd').searchItems({ keyword: '演示' }, context),
      ).rejects.toMatchObject({ code: 'adapter_unimplemented' });
    } else {
      const page = await dormant.get('jd').searchItems({ keyword: '演示' }, context);
      expect(page.items.length).toBeGreaterThan(0);
    }
    expect(observed.constructor).not.toHaveBeenCalled();
    expect(options.jdLive.credentials).not.toHaveBeenCalled();
    expect(options.jdLive.transport).not.toHaveBeenCalled();
    // Same options become effective only with mode=live; guards against ignoring jdLive.
    const live = createUnionRegistry(options);
    expect(live.registrations().find((entry) => entry.platform === 'jd')?.implemented).toBe(true);
    expect(observed.constructor).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-04ze#37] 新选项显式启用；旧无选项、test/live、prod/live 调用保持未实现且不提前拒绝', async () => {
  const observed = observeJd();
  const legacy = [
    createUnionRegistry(),
    createUnionRegistry(registryOptions('live', 'test')),
    createUnionRegistry({
      ...registryOptions('live', 'prod'),
      endpoints: endpoints('live', 'live'),
    }),
  ];
  for (const registry of legacy) {
    expect(registry.registrations().every((entry) => !entry.implemented)).toBe(true);
    await expect(
      registry.get('jd').searchItems({ keyword: 'synthetic' }, context),
    ).rejects.toMatchObject({ code: 'adapter_unimplemented' });
  }
  expect(observed.constructor).not.toHaveBeenCalled();
  const enabled = createUnionRegistry(liveOptions());
  expect(enabled.registrations().find((entry) => entry.platform === 'jd')?.implemented).toBe(true);
  expect(observed.constructor).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04ze#38] pddLive、taobaoLive 与 jdLive 同时给出时三家各自装配，凭据与传输互不串用', async () => {
  const jdOptions = liveOptions();
  const pddCredentials = vi.fn(async () => ({
    clientId: PDD_CLIENT_ID,
    clientSecret: PDD_SECRET,
  }));
  const taobaoCredentials = vi.fn(async () => ({
    appKey: TAOBAO_APP_KEY,
    appSecret: TAOBAO_SECRET,
  }));
  const pddTransport = fakeTransport();
  const taobaoTransport = fakeTransport();
  const observed = observeJd();
  const options = {
    ...jdOptions,
    endpoints: endpoints('live', 'live'),
    pddLive: { credentials: pddCredentials, transport: pddTransport },
    taobaoLive: { credentials: taobaoCredentials, transport: taobaoTransport },
  };
  const registry = createUnionRegistry(options);
  expect(registry.registrations()).toEqual([
    { platform: 'jd', implemented: true },
    { platform: 'pdd', implemented: true },
    { platform: 'taobao', implemented: true },
  ]);
  expect(registry.get('jd')).toBeInstanceOf(JdUnionAdapter);
  expect(registry.get('pdd')).toBeInstanceOf(PddUnionAdapter);
  expect(registry.get('taobao')).toBeInstanceOf(TaobaoUnionAdapter);
  expect(observed.constructor).toHaveBeenCalledTimes(1);
  const supplied = observed.constructor.mock.calls[0]![0];
  expect(supplied.transport).toBe(jdOptions.jdLive.transport);
  expect(supplied.transport).not.toBe(pddTransport);
  expect(supplied.transport).not.toBe(taobaoTransport);
  await expect(supplied.credentials()).resolves.toEqual({ appKey: APP_KEY, appSecret: SECRET });
  expect(pddCredentials).not.toHaveBeenCalled();
  expect(taobaoCredentials).not.toHaveBeenCalled();
});
