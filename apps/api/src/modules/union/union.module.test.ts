import { join } from 'node:path';
import { expect, it } from 'vitest';
import { APP_CONFIG, type AppConfig } from '../platform/index.ts';
import { UnionError, type UnionEndpoint } from './domain/types.ts';
import { UNION_ENDPOINTS, UNION_ENDPOINTS_DIR, UnionModule } from './union.module.ts';

interface FactoryProvider {
  readonly provide: unknown;
  readonly inject: readonly unknown[];
  readonly useFactory: (config: AppConfig) => Promise<readonly UnionEndpoint[]>;
}

function endpointsFactory(directory?: string): FactoryProvider {
  const providers: readonly unknown[] = UnionModule.forRoot(directory).providers ?? [];
  const provider = providers.find(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      'provide' in value &&
      value.provide === UNION_ENDPOINTS,
  );
  if (provider === undefined) throw new Error('UNION_ENDPOINTS provider missing');
  return provider as FactoryProvider;
}

function config(appEnv: AppConfig['appEnv'], unionEndpointOverrideDir?: string | null): AppConfig {
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
    ...(unionEndpointOverrideDir === undefined ? {} : { unionEndpointOverrideDir }),
  };
}

async function settle(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return error;
  }
}

it('[AC-B1-04y-UNIT#4] UNION_ENDPOINTS 只注入 APP_CONFIG；未设覆盖目录时读镜像目录', async () => {
  const provider = endpointsFactory();
  expect(provider.inject).toEqual([APP_CONFIG]);
  for (const absent of [undefined, null, '']) {
    const endpoints = await provider.useFactory(config('staging', absent));
    expect(endpoints.map((endpoint) => endpoint.platform).sort()).toEqual(['jd', 'pdd', 'taobao']);
  }
  expect(UNION_ENDPOINTS_DIR.endsWith(join('config', 'union-endpoints') + '/')).toBe(true);
});

it('[AC-B1-04y-UNIT#5] staging 覆盖目录缺失时启动失败，不退回镜像目录', async () => {
  const absent = join(UNION_ENDPOINTS_DIR, 'unit-absent-override');
  const result = await settle(() => endpointsFactory().useFactory(config('staging', absent)));
  expect(result).toBeInstanceOf(UnionError);
  expect(result).toMatchObject({ code: 'invalid_endpoint' });
});

it('[AC-B1-04y-UNIT#6] 手工构造的非 staging 配置带覆盖目录即拒绝，不读该目录', async () => {
  for (const appEnv of ['local', 'test', 'prod'] as const) {
    const result = await settle(() =>
      endpointsFactory().useFactory(config(appEnv, UNION_ENDPOINTS_DIR)),
    );
    expect(result).toBeInstanceOf(UnionError);
    expect(result).toMatchObject({ code: 'invalid_endpoint' });
  }
});
