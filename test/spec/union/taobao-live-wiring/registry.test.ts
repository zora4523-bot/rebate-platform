import { afterEach, expect, it, vi } from 'vitest';
import { PddUnionAdapter } from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';
import { createUnionRegistry } from '../../../../apps/api/src/modules/union/infra/registry.ts';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import {
  TaobaoUnionAdapter,
  type TaobaoWarning,
} from '../../../../apps/api/src/modules/union/infra/taobao/taobao-adapter.ts';
import {
  APP_KEY,
  PDD_CLIENT_ID,
  PDD_SECRET,
  SECRET,
  clock,
  context,
  endpoints,
  observeTaobao,
  registryOptions,
} from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function liveOptions() {
  const credentials = vi.fn(async () => ({ appKey: APP_KEY, appSecret: SECRET }));
  const transport = vi
    .fn<UnionTransport>()
    .mockResolvedValue({ status: 200, headers: {}, body: '{}' });
  const warn = vi.fn<(event: TaobaoWarning) => void>();
  // Extra structural option is intentional: existing exports suffice for an assertion-red test.
  // Implementation must add the typed taobaoLive option (symmetric to pddLive).
  return { ...registryOptions(), taobaoLive: { credentials, transport, warn } };
}

it('[AC-B1-04k#19] 显式 taobaoLive 装配 B1-04j，注入凭据/传输/时钟/端点/warn，注册表直接返回该适配器', async () => {
  const observed = observeTaobao();
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  const options = liveOptions();
  const registry = createUnionRegistry(options);
  expect(registry.registrations()).toEqual([
    { platform: 'jd', implemented: false },
    { platform: 'pdd', implemented: false },
    { platform: 'taobao', implemented: true },
  ]);
  expect(observed.constructor).toHaveBeenCalledTimes(1);
  const supplied = observed.constructor.mock.calls[0]![0];
  expect(supplied.endpoint).toEqual(options.endpoints.find((entry) => entry.platform === 'taobao'));
  expect(supplied.clock).toBe(clock);
  expect(supplied.transport).toBe(options.taobaoLive.transport);
  expect(supplied.warn).toBe(options.taobaoLive.warn);
  expect(supplied.credentials).toBeTypeOf('function');
  await expect(supplied.credentials()).resolves.toEqual({ appKey: APP_KEY, appSecret: SECRET });
  expect(options.taobaoLive.credentials).toHaveBeenCalledTimes(1);
  expect(registry.get('taobao')).toBe(observed.constructor.mock.results[0]!.value);
  expect(registry.get('taobao')).toBeInstanceOf(TaobaoUnionAdapter);
  for (const platform of ['jd', 'pdd'] as const) {
    await expect(
      registry.get(platform).searchItems({ keyword: 'synthetic' }, context),
    ).rejects.toMatchObject({ code: 'adapter_unimplemented' });
  }
  expect(options.taobaoLive.transport).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});

it.each(['replay', 'demo'] as const)(
  '[AC-B1-04k#20] 相同显式凭据只在 live 装配：taobao=%s 不构造真实适配器、不取凭据、不联网',
  async (mode) => {
    const observed = observeTaobao();
    const options = liveOptions();
    const dormant = createUnionRegistry({ ...options, ...registryOptions(mode) });
    expect(dormant.registrations().find((entry) => entry.platform === 'taobao')?.implemented).toBe(
      mode === 'demo',
    );
    if (mode === 'replay') {
      await expect(
        dormant.get('taobao').searchItems({ keyword: '演示' }, context),
      ).rejects.toMatchObject({ code: 'adapter_unimplemented' });
    } else {
      const page = await dormant.get('taobao').searchItems({ keyword: '演示' }, context);
      expect(page.items.length).toBeGreaterThan(0);
    }
    expect(observed.constructor).not.toHaveBeenCalled();
    expect(options.taobaoLive.credentials).not.toHaveBeenCalled();
    expect(options.taobaoLive.transport).not.toHaveBeenCalled();
    // Same options become effective only with mode=live; guards against ignoring taobaoLive.
    const live = createUnionRegistry(options);
    expect(live.registrations().find((entry) => entry.platform === 'taobao')?.implemented).toBe(
      true,
    );
    expect(observed.constructor).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-04k#21] 新选项显式启用；旧无选项、test/live、prod/live 调用保持未实现且不提前拒绝', async () => {
  const observed = observeTaobao();
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
      registry.get('taobao').searchItems({ keyword: 'synthetic' }, context),
    ).rejects.toMatchObject({ code: 'adapter_unimplemented' });
  }
  expect(observed.constructor).not.toHaveBeenCalled();
  const enabled = createUnionRegistry(liveOptions());
  expect(enabled.registrations().find((entry) => entry.platform === 'taobao')?.implemented).toBe(
    true,
  );
  expect(observed.constructor).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04k#22] pddLive 与 taobaoLive 同时给出时两家各自装配，凭据与传输互不串用', async () => {
  const taobaoOptions = liveOptions();
  const pddCredentials = vi.fn(async () => ({
    clientId: PDD_CLIENT_ID,
    clientSecret: PDD_SECRET,
  }));
  const pddTransport = vi
    .fn<UnionTransport>()
    .mockResolvedValue({ status: 200, headers: {}, body: '{}' });
  const observed = observeTaobao();
  const options = {
    ...taobaoOptions,
    endpoints: endpoints('live', 'live'),
    pddLive: { credentials: pddCredentials, transport: pddTransport },
  };
  const registry = createUnionRegistry(options);
  expect(registry.registrations()).toEqual([
    { platform: 'jd', implemented: false },
    { platform: 'pdd', implemented: true },
    { platform: 'taobao', implemented: true },
  ]);
  expect(registry.get('pdd')).toBeInstanceOf(PddUnionAdapter);
  expect(registry.get('taobao')).toBeInstanceOf(TaobaoUnionAdapter);
  expect(observed.constructor).toHaveBeenCalledTimes(1);
  const supplied = observed.constructor.mock.calls[0]![0];
  expect(supplied.transport).toBe(taobaoOptions.taobaoLive.transport);
  expect(supplied.transport).not.toBe(pddTransport);
  await expect(supplied.credentials()).resolves.toEqual({ appKey: APP_KEY, appSecret: SECRET });
  expect(pddCredentials).not.toHaveBeenCalled();
});
