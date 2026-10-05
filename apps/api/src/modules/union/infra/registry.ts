// Adapter registry. jd, pdd and taobao are pre-registered: there is no real recording,
// promotion slot or approved API yet (规划/09 §0.2 硬规则 3; 规划/11 §4.5), so a live or replay
// platform rejects every call with `adapter_unimplemented` instead of returning invented data.
// With endpoint options, a platform configured as mode=demo gets the DemoUnionAdapter (B1-04o);
// the endpoint set is validated again, so prod with any demo endpoint refuses to assemble.
// Real adapters replace the unimplemented entries under infra/<platform>/ in later tasks.
// TODO(规划/11 §4.5): 凭据读取 — blocked on 推广位 / siteId
import {
  REGISTERED_PLATFORMS,
  UnionError,
  type RegisteredPlatform,
  type UnionAdapter,
} from '../domain/types.ts';
import { DemoUnionAdapter, type DemoUnionRegistryOptions } from './demo/demo-adapter.ts';
import { parseUnionEndpoints } from './endpoints.ts';

export interface UnionRegistration {
  readonly platform: RegisteredPlatform;
  /** True only for a demo adapter today; live adapters are not implemented yet. */
  readonly implemented: boolean;
}

export interface UnionRegistry {
  registrations(): readonly UnionRegistration[];
  get(platform: RegisteredPlatform): UnionAdapter;
}

function unimplementedAdapter(platform: RegisteredPlatform): UnionAdapter {
  const reject = (operation: string): Promise<never> =>
    Promise.reject(
      new UnionError(
        'adapter_unimplemented',
        `Union adapter for ${platform} is registered but not implemented (${operation})`,
        platform,
      ),
    );
  return Object.freeze({
    platform,
    searchItems: () => reject('searchItems'),
    getItem: () => reject('getItem'),
    resolveLink: () => reject('resolveLink'),
    convert: () => reject('convert'),
    listOrders: () => reject('listOrders'),
  });
}

/**
 * Exactly jd, pdd and taobao registered. Without options every call rejects
 * `adapter_unimplemented`; with options, mode=demo endpoints get a demo adapter.
 */
export function createUnionRegistry(options?: DemoUnionRegistryOptions): UnionRegistry {
  const demoPlatforms = new Set<RegisteredPlatform>();
  if (options !== undefined) {
    // Same validation as startup: incomplete sets, and demo / replay in prod, are refused.
    for (const endpoint of parseUnionEndpoints(options.endpoints, options.environment)) {
      if (endpoint.mode === 'demo') demoPlatforms.add(endpoint.platform);
    }
  }
  const adapters = new Map<RegisteredPlatform, UnionAdapter>(
    REGISTERED_PLATFORMS.map((platform) => [
      platform,
      options !== undefined && demoPlatforms.has(platform)
        ? new DemoUnionAdapter({
            platform,
            seed: options.seed,
            clock: options.clock,
            environment: options.environment,
          })
        : unimplementedAdapter(platform),
    ]),
  );
  const registrations = Object.freeze(
    REGISTERED_PLATFORMS.map((platform) =>
      Object.freeze({ platform, implemented: demoPlatforms.has(platform) }),
    ),
  );
  return {
    registrations: () => registrations,
    get(platform) {
      const adapter = adapters.get(platform);
      if (adapter === undefined) {
        throw new UnionError(
          'adapter_unimplemented',
          `No union adapter is registered for ${String(platform)}`,
        );
      }
      return adapter;
    },
  };
}
