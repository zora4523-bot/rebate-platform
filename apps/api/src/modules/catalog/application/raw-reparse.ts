// B1-05w (FU-DETAIL-REPARSE, D10-514): BR-PROD-05 重新解析步骤 in one place, shared by the detail,
// the pool add and the pool refresh. canonical_url first, else q=title on the platform's first
// page (≤ 20 rows) for the item that derives the target key. UnionItem has no shop_id, so the
// step's shop filter cannot run and the exact key comparison stands in for it. One call at most 3 s.
// One re-parse per (app_id, product_key): a Redis lock of 10 s, concurrent callers wait for the same
// result; without Redis nothing is locked. Rule tests build a reparser with createRawReparser and
// hand it to createUnionDetailUpstream; they never call its members, so the shapes below are the
// implementer's. Rule tests: test/spec/catalog/detail-reparse/**.
import type { Clock, RedisNamespace } from '../../platform/index.ts';
import type { CallCtx, ItemRef, RegisteredPlatform } from '../../union/index.ts';
import type { Catalog, ReparseResult } from '../domain/types.ts';
import type { GovernedUnion } from '../ports.ts';

/** What one re-parse looks for; a title or a canonical_url must be there to ask the union. */
export interface RawReparseTarget {
  readonly appId: string;
  readonly platform: RegisteredPlatform;
  readonly productKey: string;
  readonly jdMode: string;
  /** product_refs' own, never user text (BR-PROD-05). */
  readonly canonicalUrl: string | null;
  readonly title: string | null;
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

export function createRawReparser(options: RawReparserOptions): RawReparser {
  void options;
  throw new Error('NotImplemented: createRawReparser');
}
