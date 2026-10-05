import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createUnionRegistry,
  type UnionEndpoint,
  type UnionRegistry,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  demo,
  firstItem,
  instant,
  keyword,
  LinkingIdentity,
  online,
  platforms,
  refOf,
  type DemoOptions,
} from './kit.ts';

it.each(['jd', 'pdd'] as const)(
  '[AC-B1-04o-IDENTITY#4] %s 不同服务端身份生成不同链接且都解析回同一商品',
  async (platform) => {
    const port = demo(platform);
    const item = refOf(await firstItem(port));
    const req = { item, idempotencyKey: 'identity-sensitive-convert' };
    const first = await port.convert(req, new LinkingIdentity(platform), online);
    const second = await port.convert(
      req,
      new LinkingIdentity(platform, {
        userId: 'server-user-b',
        promotionSlot: 'server-slot-b',
      }),
      online,
    );

    expect(first.kind).toBe('url');
    expect(second.kind).toBe('url');
    if (first.kind === 'url' && second.kind === 'url') {
      expect(first.url).not.toBe(second.url);
      expect((await port.resolveLink(first.url, online)).item).toEqual(item);
      expect((await port.resolveLink(second.url, online)).item).toEqual(item);
    }
  },
);

it(
  '[AC-B1-04o-ASSEMBLY#5] prod 允许全 live 的未实现登记，加入 demo 后才拒绝装配',
  async () => {
    // Same public registry extension as assembly.test.ts; implementation wires it later.
    const assemble = createUnionRegistry as (
      options: Omit<DemoOptions, 'platform'> & { endpoints: readonly UnionEndpoint[] },
    ) => UnionRegistry;
    const endpoints: readonly UnionEndpoint[] = platforms.map((platform) => ({
      platform,
      mode: 'live',
      baseUrl: 'https://example.invalid/union',
      quotaKey: `live:${platform}`,
    }));
    const options = {
      endpoints,
      environment: 'prod' as const,
      seed: 'catalog-a',
      clock: new FixedClock(instant),
    };

    expect(() => assemble(options)).not.toThrow();
    const registry = assemble(options);
    expect(registry.registrations()).toHaveLength(platforms.length);
    for (const platform of platforms) {
      expect(registry.registrations().find((entry) => entry.platform === platform)).toEqual({
        platform,
        implemented: false,
      });
      await expect(registry.get(platform).searchItems({ keyword }, online)).rejects.toMatchObject({
        code: 'adapter_unimplemented',
      });
    }

    // Exercise both sides of the boundary in one case: the B1-04b registry ignores options,
    // so the new case remains red until production demo rejection is implemented.
    for (const platform of platforms) {
      const mixed: readonly UnionEndpoint[] = endpoints.map((endpoint) =>
        endpoint.platform === platform ? { ...endpoint, mode: 'demo', baseUrl: null } : endpoint,
      );
      expect(() => assemble({ ...options, endpoints: mixed })).toThrow(
        expect.objectContaining({ code: 'unsafe_mode' }),
      );
    }
  },
);
