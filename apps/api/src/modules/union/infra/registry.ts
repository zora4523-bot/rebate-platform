// Adapter registry. jd, pdd and taobao are pre-registered: there is no real recording,
// promotion slot or approved API yet (规划/09 §0.2 硬规则 3; 规划/11 §4.5), so a live or replay
// platform rejects every call with `adapter_unimplemented` instead of returning invented data.
// With endpoint options, a platform configured as mode=demo gets the DemoUnionAdapter (B1-04o);
// the endpoint set is validated again, so prod with any demo endpoint refuses to assemble.
// B1-04t: only when the caller passes `pddLive` (credentials provider + transport) does a pdd
// endpoint with mode=live get the real PddUnionAdapter of B1-04g, returned as is: governance is
// wrapped once by the existing caller (app.module.ts governedUnion), not here. Without `pddLive`,
// pdd live / replay stay `adapter_unimplemented`; which environments may pass `pddLive` is decided
// by union.module.ts. B1-04x: `pddLive.queryIdentity` (assembled by union.module.ts) is handed to
// the adapter as is; without it every goods call is refused `upstream_rejected` by the adapter. Real jd / taobao adapters replace their entries in later tasks.
// TODO(规划/11 §4.5): jd / taobao 凭据读取 — blocked on 推广位 / siteId
import {
  REGISTERED_PLATFORMS,
  UnionError,
  type CallCtx,
  type RegisteredPlatform,
  type UnionAdapter,
} from '../domain/types.ts';
import { DemoUnionAdapter, type DemoUnionRegistryOptions } from './demo/demo-adapter.ts';
import { parseUnionEndpoints } from './endpoints.ts';
import { PddUnionAdapter, type PddCredentials, type PddQueryIdentity } from './pdd/pdd-adapter.ts';
import type { PddWarning } from './pdd/response.ts';
import type { UnionTransport } from './replay.ts';

/** The real Pinduoduo adapter's injected dependencies (B1-04t); used only for mode=live. */
export interface PddLiveOptions {
  /** Hands out the credentials already read at startup; never reads a file or the environment. */
  readonly credentials: () => Promise<PddCredentials>;
  readonly transport: UnionTransport;
  readonly warn?: (event: PddWarning) => void;
  /** Query identity provider of the goods ports (B1-04x), called with the CallCtx of each call. */
  readonly queryIdentity?: (ctx: CallCtx) => Promise<PddQueryIdentity>;
}

export interface UnionRegistryOptions extends DemoUnionRegistryOptions {
  readonly pddLive?: PddLiveOptions;
}

export interface UnionRegistration {
  readonly platform: RegisteredPlatform;
  /** True for a demo adapter and for the real pdd adapter assembled through `pddLive`. */
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
    // B1-06v: the Pinduoduo authority query is optional; the placeholder refuses it like the rest.
    // TODO(规划/11 §4.5): 真实备案查询 — blocked on CAP-PDD-05。
    ...(platform === 'pdd' ? { queryPddAuthority: () => reject('queryPddAuthority') } : {}),
  });
}

/**
 * Exactly jd, pdd and taobao registered. Without options every call rejects
 * `adapter_unimplemented`; with options, mode=demo endpoints get a demo adapter, and a pdd
 * endpoint with mode=live gets the real PddUnionAdapter when `pddLive` is given.
 */
export function createUnionRegistry(options?: UnionRegistryOptions): UnionRegistry {
  const demoPlatforms = new Set<RegisteredPlatform>();
  let pddLive: UnionAdapter | undefined;
  if (options !== undefined) {
    // Same validation as startup: incomplete sets, and demo / replay in prod, are refused.
    for (const endpoint of parseUnionEndpoints(options.endpoints, options.environment)) {
      if (endpoint.mode === 'demo') demoPlatforms.add(endpoint.platform);
      if (endpoint.platform === 'pdd' && endpoint.mode === 'live' && options.pddLive) {
        const live = options.pddLive;
        pddLive = new PddUnionAdapter({
          credentials: live.credentials,
          transport: live.transport,
          clock: options.clock,
          endpoint,
          ...(live.warn === undefined ? {} : { warn: live.warn }),
          ...(live.queryIdentity === undefined ? {} : { queryIdentity: live.queryIdentity }),
        });
      }
    }
  }
  const adapterFor = (platform: RegisteredPlatform): UnionAdapter => {
    if (platform === 'pdd' && pddLive !== undefined) return pddLive;
    if (options !== undefined && demoPlatforms.has(platform)) {
      return new DemoUnionAdapter({
        platform,
        seed: options.seed,
        clock: options.clock,
        environment: options.environment,
        ...(options.warn === undefined ? {} : { warn: options.warn }),
      });
    }
    return unimplementedAdapter(platform);
  };
  const adapters = new Map<RegisteredPlatform, UnionAdapter>(
    REGISTERED_PLATFORMS.map((platform) => [platform, adapterFor(platform)]),
  );
  const registrations = Object.freeze(
    REGISTERED_PLATFORMS.map((platform) =>
      Object.freeze({
        platform,
        implemented: demoPlatforms.has(platform) || (platform === 'pdd' && pddLive !== undefined),
      }),
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
