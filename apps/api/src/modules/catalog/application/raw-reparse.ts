// B1-05w (FU-DETAIL-REPARSE, D10-514): BR-PROD-05 重新解析步骤 in one place, shared by the detail,
// the pool add and the pool refresh. canonical_url first, else q=title on the platform's first
// page (≤ 20 rows) for the item that derives the target key. UnionItem has no shop_id, so the
// step's shop filter cannot run and the exact key comparison stands in for it. One call at most 3 s.
// One re-parse per (app_id, product_key): a Redis lock of 10 s, concurrent callers wait for the same
// result; without Redis nothing is locked. Rule tests build a reparser with createRawReparser and
// hand it to createUnionDetailUpstream; they never call its members, so the shapes below are the
// implementer's. Rule tests: test/spec/catalog/detail-reparse/**.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  GovernanceError,
  RedisUnavailableError,
  type Clock,
  type RedisNamespace,
} from '../../platform/index.ts';
import {
  UnionError,
  type CallCtx,
  type ItemRef,
  type Platform,
  type RegisteredPlatform,
  type UnionAdapter,
  type UnionItem,
} from '../../union/index.ts';
import { detailRawItemId, upstreamFailure } from '../detail.ts';
import { CatalogError } from '../domain/rules.ts';
import type { Catalog, ProductCapabilities, ProductRef, ReparseResult } from '../domain/types.ts';
import type { GovernedUnion } from '../ports.ts';

/** What one re-parse looks for; a title or a canonical_url must be there to ask the union. */
export interface RawReparseTarget {
  readonly appId: string;
  readonly platform: RegisteredPlatform;
  readonly productKey: string;
  readonly jdMode: string;
  /** product_refs' own, never user text (BR-PROD-05). */
  readonly canonicalUrl: string | null;
  readonly title: string;
  readonly shopId?: string | null;
  readonly shopType?: string | null;
  /** The product_refs source of the caller (BR-PROD-05: detail or pool). */
  readonly source: 'detail' | 'pool';
  /** BR-PROD-03's single derivation against the target key. */
  readonly isTarget: (item: ItemRef) => boolean | Promise<boolean>;
}

export interface RawReparser {
  reparse(target: RawReparseTarget): Promise<ReparseResult>;
}

export interface RawReparserOptions {
  readonly union: GovernedUnion;
  readonly clock: Clock;
  /** Where a found raw ID goes (步骤 4); absent, the caller writes it (Catalog.takeRawItemId). */
  readonly catalog?: Pick<Catalog, 'registerProductRef'>;
  /** The lock's store; null means no lock. */
  readonly redis: RedisNamespace | null;
  /** Quota purpose of every union call; `online` unless the caller names another. */
  readonly purpose?: CallCtx['purpose'];
}

/** The union's answer to one re-parse; rawFetchedAt null means the receipt instant of that answer. */
export type RawParse =
  | {
      readonly kind: 'found';
      readonly ref: Pick<ProductRef, 'rawItemId' | 'title'> & {
        readonly rawFetchedAt: string | null;
      };
    }
  | Exclude<ReparseResult, { readonly kind: 'found' }>;

/** Redis namespace of the re-parse lock and of the result its waiters read. */
export const RAW_REPARSE_NAMESPACE = 'catalog-reparse';
/** BR-PROD-05 重新解析步骤 2: the title search reads the platform's first page, ≤ 20 rows. */
const SEARCH_ROWS = 20;
/** BR-PROD-05 重新解析步骤 3. */
const CALL_TIMEOUT_MS = 3000;
const LOCK_TTL_SECONDS = 10;
/** A waiter outlasts the holder's one call by a second; a holder that died is no reason to hang. */
const WAIT_POLLS = 80;
const WAIT_POLL_MS = 50;
const REF_EXPIRED = { kind: 'ref_expired' } as const;
const TEMPORARY_FAILURE = { kind: 'temporary_failure' } as const;
/** BR-PROD-10: a re-parse does not depend on the keyword search switch, as the detail route. */
const REF_CAPABILITIES: ProductCapabilities = Object.freeze({
  parseEnabled: true,
  searchEnabled: false,
});

/** Takes the lock with ARGV[2] as its owner; answers the owner, which is the caller when it won. */
const CLAIM_LOCK = `
local held = redis.call('GET', KEYS[1])
if held then return held end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[1])
return ARGV[2]
`;
/** Only the owner lets go; this script writes nothing, so ARGV[1] goes unused. */
const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[2] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/** What the title search of BR-PROD-05 重新解析步骤 2 looks for, and on which call context. */
export interface TitleSearch {
  readonly adapter: Pick<UnionAdapter, 'searchItems'>;
  readonly platform: Platform;
  readonly title: string;
  readonly jdMode: string;
  readonly context: CallCtx;
  readonly isTarget: (item: UnionItem) => boolean | Promise<boolean>;
}

/** BR-PROD-05 重新解析步骤 2; null when no item of the key can be found by title (引用失效). */
export async function searchRawByTitle(
  search: TitleSearch,
): Promise<{ readonly raw: string; readonly item: UnionItem } | null> {
  const { adapter, platform, title, jdMode, context, isTarget } = search;
  let page: Awaited<ReturnType<UnionAdapter['searchItems']>>;
  try {
    page = await adapter.searchItems({ keyword: title }, context);
  } catch (error: unknown) {
    // A platform that has no title search answers like a page without the key; it is no outage.
    if (error instanceof UnionError && error.code === 'adapter_unimplemented') return null;
    throw error;
  }
  for (const item of page.items.slice(0, SEARCH_ROWS)) {
    if (item.platform !== platform) continue;
    const raw = detailRawItemId(item, jdMode);
    if (raw !== undefined && (await isTarget(item))) return { raw, item };
  }
  return null;
}

/** Past the limit the call counts as the governor's own timeout: 结果分类 ③, whatever it ends in. */
function withinLimit<T>(call: Promise<T>, dependency: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new GovernanceError('timeout', dependency, 'catalog: re-parse call past its limit'));
    }, CALL_TIMEOUT_MS);
    call.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

/** BR-PROD-05 重新解析步骤 1、2, one union call, sorted into 结果分类. No lock and no write. */
export async function parseRaw(
  union: GovernedUnion,
  target: RawReparseTarget,
  purpose: CallCtx['purpose'],
): Promise<RawParse> {
  const { appId, platform, canonicalUrl, title, jdMode, isTarget } = target;
  const adapter = union.adapter(platform);
  const context: CallCtx = { appId, requestId: randomUUID(), purpose };
  const dependency = `union:${platform}:${purpose}`;
  try {
    if (canonicalUrl !== null) {
      const { item } = await withinLimit(adapter.resolveLink(canonicalUrl, context), dependency);
      const raw = item.platform === platform ? detailRawItemId(item, jdMode) : undefined;
      if (raw === undefined || !(await isTarget(item))) return REF_EXPIRED;
      return { kind: 'found', ref: { rawItemId: raw, title, rawFetchedAt: null } };
    }
    const found = await searchRawByTitle({
      adapter: {
        searchItems: (query, ctx) => withinLimit(adapter.searchItems(query, ctx), dependency),
      },
      platform,
      title,
      jdMode,
      context,
      isTarget,
    });
    if (found === null) return REF_EXPIRED;
    return {
      kind: 'found',
      ref: { rawItemId: found.raw, title, rawFetchedAt: found.item.quoted_at },
    };
  } catch (error: unknown) {
    const mapped = upstreamFailure(error);
    if (!(mapped instanceof CatalogError)) throw mapped;
    if (mapped.code === 30141) return { kind: 'off_shelf' };
    if (mapped.code === 30143) return REF_EXPIRED;
    if (mapped.code === 50401) return TEMPORARY_FAILURE;
    throw mapped;
  }
}

export function createRawReparser(options: RawReparserOptions): RawReparser {
  const { union, clock, catalog, redis, purpose = 'online' } = options;

  async function attempt(target: RawReparseTarget): Promise<ReparseResult> {
    const parsed = await parseRaw(union, target, purpose);
    if (parsed.kind !== 'found') return parsed;
    const receivedAt = clock.now().toISOString();
    const ref: ProductRef = {
      appId: target.appId,
      platform: target.platform,
      productKey: target.productKey,
      rawItemId: parsed.ref.rawItemId,
      rawFetchedAt: parsed.ref.rawFetchedAt ?? receivedAt,
      receivedAt,
      canonicalUrl: target.canonicalUrl,
      title: parsed.ref.title,
      shopId: target.shopId ?? null,
      shopType: target.shopType ?? null,
      source: target.source,
    };
    await catalog?.registerProductRef(ref, REF_CAPABILITIES);
    return { kind: 'found', ref };
  }

  /** The lock's owner; null when Redis cannot answer, so nothing is locked. */
  async function claim(
    store: RedisNamespace,
    lockKey: string,
    token: string,
  ): Promise<string | null> {
    try {
      const owner = await store.eval(CLAIM_LOCK, {
        keys: [lockKey],
        args: [token],
        ttlSeconds: LOCK_TTL_SECONDS,
      });
      return String(owner);
    } catch (error: unknown) {
      if (error instanceof RedisUnavailableError) return null;
      throw error;
    }
  }

  /** The owner's result; a holder that never publishes is a temporary failure, null a lost Redis. */
  async function resultOf(store: RedisNamespace, owner: string): Promise<ReparseResult | null> {
    try {
      for (let poll = 0; poll < WAIT_POLLS; poll += 1) {
        const text = await store.get(resultKey(owner));
        if (text !== null) return JSON.parse(text) as ReparseResult;
        await sleep(WAIT_POLL_MS);
      }
    } catch (error: unknown) {
      if (error instanceof RedisUnavailableError) return null;
      throw error;
    }
    return TEMPORARY_FAILURE;
  }

  /** The result stays under the owner, so a retry after release asks the union again. */
  async function settle(
    store: RedisNamespace,
    lockKey: string,
    token: string,
    result: ReparseResult,
  ): Promise<void> {
    try {
      await store.set(resultKey(token), JSON.stringify(result), LOCK_TTL_SECONDS);
      await store.eval(RELEASE_LOCK, { keys: [lockKey], args: [token], ttlSeconds: 1 });
    } catch (error: unknown) {
      // The lock then expires on its own, and its waiters stop at the end of their polls.
      if (!(error instanceof RedisUnavailableError)) throw error;
    }
  }

  return {
    async reparse(target) {
      if (redis === null) return attempt(target);
      const lockKey = `lock:${target.appId}:${target.productKey}`;
      const token = randomUUID();
      const owner = await claim(redis, lockKey, token);
      if (owner === null) return attempt(target);
      if (owner !== token) return (await resultOf(redis, owner)) ?? attempt(target);
      let result: ReparseResult = TEMPORARY_FAILURE;
      try {
        result = await attempt(target);
        return result;
      } finally {
        await settle(redis, lockKey, token, result);
      }
    },
  };
}

function resultKey(owner: string): string {
  return `result:${owner}`;
}
