import { afterEach, expect, it, vi } from 'vitest';
import { createUnionRegistry } from '../../../../apps/api/src/modules/union/infra/registry.ts';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { CLIENT_ID, SECRET, clock, context, observePdd, registryOptions } from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function liveOptions() {
  const credentials = vi.fn(async () => ({ clientId: CLIENT_ID, clientSecret: SECRET }));
  const transport = vi
    .fn<UnionTransport>()
    .mockResolvedValue({ status: 200, headers: {}, body: '{}' });
  // Extra structural option is intentional: existing exports suffice for an assertion-red test.
  // Implementation must add the typed pddLive option; no application behavior is changed here.
  return { ...registryOptions(), pddLive: { credentials, transport } };
}

it('[AC-B1-04t-REGISTRY#1] 显式 pddLive 装配 B1-04g，注入凭据/传输/时钟/端点，直接委托适配器', async () => {
  const observed = observePdd();
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  const options = liveOptions();
  const registry = createUnionRegistry(options);
  expect(registry.registrations()).toEqual([
    { platform: 'jd', implemented: false },
    { platform: 'pdd', implemented: true },
    { platform: 'taobao', implemented: false },
  ]);
  expect(observed.constructor).toHaveBeenCalledTimes(1);
  const supplied = observed.constructor.mock.calls[0]![0];
  expect(supplied.endpoint).toEqual(options.endpoints.find((entry) => entry.platform === 'pdd'));
  expect(supplied.clock).toBe(clock);
  expect(supplied.transport).toBe(options.pddLive.transport);
  expect(supplied.credentials).toBeTypeOf('function');
  await expect(supplied.credentials()).resolves.toEqual({
    clientId: CLIENT_ID,
    clientSecret: SECRET,
  });
  expect(options.pddLive.credentials).toHaveBeenCalledTimes(1);
  expect(registry.get('pdd')).toBe(observed.constructor.mock.results[0]!.value);
  await registry.get('pdd').searchItems({ keyword: 'synthetic' }, context);
  expect(observed.search).toHaveBeenCalledExactlyOnceWith({ keyword: 'synthetic' }, context);
  for (const platform of ['jd', 'taobao'] as const) {
    await expect(
      registry.get(platform).searchItems({ keyword: 'synthetic' }, context),
    ).rejects.toMatchObject({ code: 'adapter_unimplemented' });
  }
  expect(network).not.toHaveBeenCalled();
});

it.each(['replay', 'demo'] as const)(
  '[AC-B1-04t-REGISTRY#2] 相同显式凭据仅在 live 装配：%s 不构造真实适配器、不取凭据或联网',
  async (mode) => {
    const observed = observePdd();
    const options = liveOptions();
    const dormant = createUnionRegistry({ ...options, ...registryOptions(mode) });
    expect(dormant.registrations().find((entry) => entry.platform === 'pdd')?.implemented).toBe(
      mode === 'demo',
    );
    if (mode === 'replay') {
      await expect(
        dormant.get('pdd').searchItems({ keyword: '演示' }, context),
      ).rejects.toMatchObject({ code: 'adapter_unimplemented' });
    } else {
      const page = await dormant.get('pdd').searchItems({ keyword: '演示' }, context);
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every((item) => item.title.includes('演示'))).toBe(true);
    }
    expect(observed.constructor).not.toHaveBeenCalled();
    expect(options.pddLive.credentials).not.toHaveBeenCalled();
    expect(options.pddLive.transport).not.toHaveBeenCalled();
    // Same options become effective only with mode=live; guards against ignoring pddLive entirely.
    const live = createUnionRegistry(options);
    expect(live.registrations().find((entry) => entry.platform === 'pdd')?.implemented).toBe(true);
    expect(observed.constructor).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-04t-REGISTRY#3] 新选项显式启用；旧无选项、test/live、prod/live 调用保持未实现且不提前拒绝', async () => {
  const observed = observePdd();
  const legacy = [
    createUnionRegistry(),
    createUnionRegistry(registryOptions('live', 'test')),
    createUnionRegistry(registryOptions('live', 'prod')),
  ];
  for (const registry of legacy) {
    expect(registry.registrations().every((entry) => !entry.implemented)).toBe(true);
    for (const platform of ['jd', 'pdd', 'taobao'] as const) {
      await expect(
        registry.get(platform).searchItems({ keyword: 'synthetic' }, context),
      ).rejects.toMatchObject({ code: 'adapter_unimplemented' });
    }
  }
  expect(observed.constructor).not.toHaveBeenCalled();
  const enabled = createUnionRegistry(liveOptions());
  expect(enabled.registrations().find((entry) => entry.platform === 'pdd')?.implemented).toBe(true);
  expect(observed.constructor).toHaveBeenCalledTimes(1);
});
