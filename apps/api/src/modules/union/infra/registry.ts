// Adapter registry. jd, pdd and taobao are pre-registered only: there is no real recording,
// promotion slot or approved API yet (规划/09 §0.2 硬规则 3; 规划/11 §4.5), so every call rejects
// with `adapter_unimplemented` instead of returning invented data. The demo adapter arrives with
// B1-04o; real adapters replace these entries under infra/<platform>/ in later tasks.
// TODO(规划/11 §4.5): 凭据读取 — blocked on 推广位 / siteId
import {
  REGISTERED_PLATFORMS,
  UnionError,
  type RegisteredPlatform,
  type UnionAdapter,
} from '../domain/types.ts';

export interface UnionRegistration {
  readonly platform: RegisteredPlatform;
  readonly implemented: false;
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

/** Exactly jd, pdd and taobao registered; all their calls reject `adapter_unimplemented`. */
export function createUnionRegistry(): UnionRegistry {
  const adapters = new Map(
    REGISTERED_PLATFORMS.map((platform) => [platform, unimplementedAdapter(platform)] as const),
  );
  const registrations = Object.freeze(
    REGISTERED_PLATFORMS.map((platform) =>
      Object.freeze({ platform, implemented: false as const }),
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
