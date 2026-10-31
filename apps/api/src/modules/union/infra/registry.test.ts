import { expect, it, vi } from 'vitest';
import {
  FixedClock,
  TaobaoStartupError,
  type AppConfig,
  type RootLogger,
} from '../../platform/index.ts';
import type { CallCtx, UnionEndpoint, UnionMode } from '../domain/types.ts';
import { UNION_REGISTRY, UnionModule } from '../union.module.ts';
import { PddUnionAdapter } from './pdd/pdd-adapter.ts';
import { createUnionRegistry, type UnionRegistry } from './registry.ts';
import type { UnionTransport } from './replay.ts';
import { TaobaoUnionAdapter } from './taobao/taobao-adapter.ts';

const clock = new FixedClock('2026-10-14T08:00:00.000Z');
const ctx: CallCtx = { appId: 'fake-app', requestId: 'fake-request', purpose: 'online' };

function endpoints(pdd: UnionMode): UnionEndpoint[] {
  return (['jd', 'pdd', 'taobao'] as const).map((platform) => {
    const mode = platform === 'pdd' ? pdd : 'live';
    return {
      platform,
      mode,
      baseUrl: mode === 'demo' ? null : `https://${platform}.invalid/router`,
      quotaKey: `fake:${platform}`,
    };
  });
}

function pddLive() {
  return {
    credentials: vi.fn(async () => ({ clientId: 'FAKE_ID', clientSecret: 'FAKE_SECRET' })),
    transport: vi.fn<UnionTransport>().mockResolvedValue({ status: 200, headers: {}, body: '{}' }),
  };
}

it('[AC-B1-04t-UNIT#4] pddLive + mode=live 直接返回真实 pdd 适配器，其余平台不变', async () => {
  const registry = createUnionRegistry({
    endpoints: endpoints('live'),
    environment: 'staging',
    seed: 'fake',
    clock,
    pddLive: pddLive(),
  });
  expect(registry.get('pdd')).toBeInstanceOf(PddUnionAdapter);
  expect(registry.registrations().map((entry) => entry.implemented)).toEqual([false, true, false]);
  await expect(registry.get('jd').searchItems({ keyword: 'x' }, ctx)).rejects.toMatchObject({
    code: 'adapter_unimplemented',
  });
});

it('[AC-B1-04t-UNIT#5] replay 或不传 pddLive 时 pdd 仍未实现，不取凭据', async () => {
  for (const options of [
    { endpoints: endpoints('replay'), pddLive: pddLive() },
    { endpoints: endpoints('live') },
  ]) {
    const registry = createUnionRegistry({
      environment: 'staging',
      seed: 'fake',
      clock,
      ...options,
    });
    expect(registry.get('pdd')).not.toBeInstanceOf(PddUnionAdapter);
    await expect(registry.get('pdd').searchItems({ keyword: 'x' }, ctx)).rejects.toMatchObject({
      code: 'adapter_unimplemented',
    });
    if ('pddLive' in options) expect(options.pddLive.credentials).not.toHaveBeenCalled();
  }
});

function taobaoEndpoints(taobao: UnionMode, pdd: UnionMode = 'replay'): UnionEndpoint[] {
  return endpoints(pdd).map((endpoint) =>
    endpoint.platform === 'taobao'
      ? {
          ...endpoint,
          mode: taobao,
          baseUrl: taobao === 'demo' ? null : 'https://taobao.invalid/router/rest',
        }
      : endpoint,
  );
}

function taobaoLive() {
  return {
    credentials: vi.fn(async () => ({ appKey: 'FAKE_KEY', appSecret: 'FAKE_SECRET' })),
    transport: vi.fn<UnionTransport>().mockResolvedValue({ status: 200, headers: {}, body: '{}' }),
  };
}

it('[AC-B1-04k-UNIT#4] taobaoLive + mode=live 返回真实淘宝适配器；replay 或不传时仍未实现、不取凭据', async () => {
  const live = taobaoLive();
  const registry = createUnionRegistry({
    endpoints: taobaoEndpoints('live'),
    environment: 'staging',
    seed: 'fake',
    clock,
    taobaoLive: live,
  });
  expect(registry.get('taobao')).toBeInstanceOf(TaobaoUnionAdapter);
  expect(registry.registrations().map((entry) => entry.implemented)).toEqual([false, false, true]);
  for (const options of [
    { endpoints: taobaoEndpoints('replay'), taobaoLive: live },
    { endpoints: taobaoEndpoints('live') },
  ]) {
    const other = createUnionRegistry({ environment: 'staging', seed: 'fake', clock, ...options });
    expect(other.get('taobao')).not.toBeInstanceOf(TaobaoUnionAdapter);
    await expect(other.get('taobao').searchItems({ keyword: 'x' }, ctx)).rejects.toMatchObject({
      code: 'adapter_unimplemented',
    });
  }
  expect(live.credentials).not.toHaveBeenCalled();
  expect(live.transport).not.toHaveBeenCalled();
});

/** The union module's UNION_REGISTRY factory over a hand-built config (no Nest bootstrap). */
async function startRegistry(
  appConfig: AppConfig,
  configured: readonly UnionEndpoint[],
): Promise<{ registry: UnionRegistry; warn: ReturnType<typeof vi.fn> }> {
  const providers: readonly unknown[] = UnionModule.forRoot().providers ?? [];
  const provider = providers.find(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      'provide' in value &&
      value.provide === UNION_REGISTRY,
  ) as { useFactory: (...args: unknown[]) => Promise<UnionRegistry> } | undefined;
  if (provider === undefined) throw new Error('UNION_REGISTRY provider missing');
  const warn = vi.fn();
  const logger = { warn, child: () => logger } as unknown as RootLogger;
  return { registry: await provider.useFactory(configured, appConfig, clock, logger), warn };
}

function appConfig(appEnv: AppConfig['appEnv']): AppConfig {
  return {
    appEnv,
    logLevel: 'silent',
    clockNow: undefined,
    exitAfterInit: false,
    apiHost: '127.0.0.1',
    apiPort: 3100,
    streamPort: 3101,
    adminPort: 3102,
    keyring: null,
    jwt: null,
  };
}

async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return 'resolved';
}

it('[AC-B1-04k-UNIT#5] 模块工厂：staging 的 taobao/live 两个变量都没设时不装配、保持未实现且不告警', async () => {
  for (const config of [appConfig('staging'), { ...appConfig('staging'), taobao: null }]) {
    const { registry, warn } = await startRegistry(config, taobaoEndpoints('live'));
    expect(registry.get('taobao')).not.toBeInstanceOf(TaobaoUnionAdapter);
    expect(registry.registrations().every((entry) => !entry.implemented)).toBe(true);
    await expect(registry.get('taobao').searchItems({ keyword: 'x' }, ctx)).rejects.toMatchObject({
      code: 'adapter_unimplemented',
    });
    expect(warn).not.toHaveBeenCalled();
  }
  // A hand-built local config without taobao variables is still refused (no silent fallback).
  const local = await refusal(() => startRegistry(appConfig('local'), taobaoEndpoints('live')));
  expect(local).toBeInstanceOf(TaobaoStartupError);
  expect(local).toMatchObject({ code: 'live_in_local' });
});

it('[AC-B1-04k-UNIT#6] 模块工厂：prod 的 taobao/live 自身即拒绝（不依赖 pdd 先拒，有无变量都拒），不读文件', async () => {
  // pdd is replay here only to keep pdd's own prod refusal out of the way (the factory receives
  // the endpoints as given); taobao's refusal must come from the taobao branch itself.
  const result = await refusal(() =>
    startRegistry(
      { ...appConfig('prod'), taobao: { appKey: 'FAKE_KEY', secretFile: '/FAKE_PROD/secret' } },
      taobaoEndpoints('live'),
    ),
  );
  expect(result).toBeInstanceOf(TaobaoStartupError);
  expect(result).toMatchObject({ code: 'kms_unavailable' });
  expect(String((result as Error).message)).not.toContain('FAKE_PROD');
  const bare = await refusal(() => startRegistry(appConfig('prod'), taobaoEndpoints('live')));
  expect(bare).toBeInstanceOf(TaobaoStartupError);
  expect(bare).toMatchObject({ code: 'kms_unavailable' });
});
