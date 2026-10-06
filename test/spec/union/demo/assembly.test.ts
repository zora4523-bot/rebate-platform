import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { FixedClock, loadConfig } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createUnionRegistry,
  loadUnionEndpoints,
  type UnionEndpoint,
  type UnionEnvironment,
  type UnionRegistry,
} from '../../../../apps/api/src/modules/union/index.ts';
import { demoConstructor, instant, keyword, online, platforms, type DemoOptions } from './kit.ts';

// The implementation adds an optional registry argument; existing no-argument B1-04b callers
// keep their unimplemented registrations. No private module import or test-time patching.
const assemble = createUnionRegistry as (
  options: Omit<DemoOptions, 'platform'> & { endpoints: readonly UnionEndpoint[] },
) => UnionRegistry;
const endpoints: readonly UnionEndpoint[] = platforms.map((platform) => ({
  platform,
  mode: 'demo',
  baseUrl: null,
  quotaKey: `demo:${platform}`,
}));

it.each(['local', 'test', 'staging'] as const)(
  '[AC-B1-04o-ASSEMBLY#1] %s 按 mode=demo 装配三个可用演示适配器',
  async (environment) => {
    const directory = fileURLToPath(
      new URL('../../../../config/union-endpoints/', import.meta.url),
    );
    const configured = await loadUnionEndpoints(directory, environment);
    const registry = assemble({
      endpoints: configured,
      environment,
      seed: 'catalog-a',
      clock: new FixedClock(instant),
    });
    expect(registry.registrations()).toHaveLength(3);
    for (const platform of platforms) {
      expect(registry.registrations().find((entry) => entry.platform === platform)).toMatchObject({
        platform,
        implemented: true,
      });
      const page = await registry.get(platform).searchItems({ keyword }, online);
      expect(page.items.length).toBeGreaterThan(0);
      expect(
        page.items.every((item) => item.platform === platform && item.title.includes('演示')),
      ).toBe(true);
    }
  },
);

it.each(platforms)(
  '[AC-B1-04o-ASSEMBLY#4] 仅 %s 配成 demo 时，其余 live/replay 登记不会悄悄返回演示数据',
  async (platform) => {
    const others = platforms.filter((candidate) => candidate !== platform);
    const mixed: readonly UnionEndpoint[] = endpoints.map((endpoint) =>
      endpoint.platform === platform
        ? endpoint
        : {
            ...endpoint,
            mode: endpoint.platform === others[0] ? 'live' : 'replay',
            baseUrl: 'https://example.invalid/union',
          },
    );
    const registry = assemble({
      endpoints: mixed,
      environment: 'test',
      seed: 'catalog-a',
      clock: new FixedClock(instant),
    });
    expect(registry.registrations().find((entry) => entry.platform === platform)).toMatchObject({
      implemented: true,
    });
    expect(
      (await registry.get(platform).searchItems({ keyword }, online)).items.length,
    ).toBeGreaterThan(0);
    for (const other of others) {
      expect(registry.registrations().find((entry) => entry.platform === other)).toMatchObject({
        implemented: false,
      });
      await expect(registry.get(other).searchItems({ keyword }, online)).rejects.toMatchObject({
        code: 'adapter_unimplemented',
      });
    }
  },
);

it.each(platforms)(
  '[AC-B1-04o-ASSEMBLY#2] APP_ENV=prod 时任一 %s demo 配置阻止装配',
  (platform) => {
    // Pure config parsing: this inert path is never opened and no KMS provider is started.
    const config = loadConfig({
      APP_ENV: 'prod',
      FIELD_KEY_PROVIDER: 'kms',
      FIELD_KEYRING_FILE: '/demo-unused/keyring.json',
    });
    const mixed: readonly UnionEndpoint[] = endpoints.map((endpoint) =>
      endpoint.platform === platform
        ? endpoint
        : { ...endpoint, mode: 'live', baseUrl: 'https://example.invalid/union' },
    );
    expect(() =>
      assemble({
        endpoints: mixed,
        environment: config.appEnv,
        seed: 'catalog-a',
        clock: new FixedClock(instant),
      }),
    ).toThrow(expect.objectContaining({ code: 'unsafe_mode' }));
  },
);

it.each(platforms)(
  '[AC-B1-04o-ASSEMBLY#3] %s 直接创建演示适配器也不能绕过 prod 禁令',
  (platform) => {
    const Constructor = demoConstructor();
    const environment: UnionEnvironment = 'prod';
    expect(
      () =>
        new Constructor({
          platform,
          environment,
          seed: 'catalog-a',
          clock: new FixedClock(instant),
        }),
    ).toThrow(expect.objectContaining({ code: 'unsafe_mode' }));
  },
);
