// B1-05c: public catalog/index.ts only. Factories are called inside each it, before fixture
// SQL/rejection assertions, so the initial failure is NotImplemented (not a missing table).
// Schema source: B1-05a, origin/main 0bf1427, db/schema.sql; this stacked worktree still needs
// that dependency before green verification. No test creates business tables or migrations.
// Local filtering convention (no status vocabulary exists in contracts): active enables a
// row; other statuses disable it. A row matches its app/platform/category and, when non-null,
// a literal title substring. Null keyword blocks the whole category. No regex or fuzzy match.
// item_ref verification, link/quote implementation, HTTP, cache/pool side effects and app.module
// wiring belong to the follow-up tasks/implementation phase, not this foundation contract.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { vi } from 'vitest';
import {
  createCatalog,
  type ProductRef,
  type RawItemRequest,
  type ReparseResult,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';

export const START = '2031-05-06T07:08:09.000Z';
export const enabled = { parseEnabled: true, searchEnabled: true };

export function instant(deltaMs: number): string {
  return new Date(Date.parse(START) + deltaMs).toISOString();
}

export function reference(overrides: Partial<ProductRef> = {}): ProductRef {
  return {
    appId: 'catalog-a',
    platform: 'taobao',
    productKey: 'tb:K1',
    rawItemId: 'X-K1',
    rawFetchedAt: START,
    receivedAt: START,
    canonicalUrl: null,
    title: '测试商品',
    shopId: 'shop-a',
    shopType: null,
    source: 'search',
    ...overrides,
  };
}

export function setup(db: Kysely<DB>) {
  const clock = new FixedClock(START);
  const warn = vi.fn();
  const catalog = createCatalog({ db, clock, warn });
  return { catalog, clock, warn };
}

export function rawRequest(overrides: Partial<RawItemRequest> = {}): RawItemRequest {
  return {
    appId: 'catalog-a',
    platform: 'taobao',
    productKey: 'tb:K1',
    requestRef: null,
    fallbackEnabled: false,
    capabilities: enabled,
    reparse: vi.fn(async (): Promise<ReparseResult> => ({
      kind: 'found',
      ref: reference({ source: 'parse', rawItemId: 'Y-K1' }),
    })),
    ...overrides,
  };
}

export async function aliases(db: Kysely<DB>, keys: readonly string[]): Promise<void> {
  for (let i = 1; i < keys.length; i += 1) {
    await sql`INSERT INTO app.product_key_aliases (old_key, new_key, reason, adr_id)
      VALUES (${keys[i - 1]}, ${keys[i]}, '一对一格式变更测试', 'ADR-test')`.execute(db);
  }
}

/** SQL is confined to fixture setup/observations; all tested operations use the public API. */
export async function stored(db: Kysely<DB>, appId: string, productKey: string) {
  return (
    await sql<{
      app_id: string;
      product_key: string;
      platform: string;
      raw_item_id: string;
      source: string;
      refreshed_at: Date;
      raw_fetched_at: Date;
      title: string;
      shop_id: string | null;
      shop_type: string | null;
      canonical_url: string | null;
    }>`SELECT * FROM app.product_refs WHERE app_id = ${appId} AND product_key = ${productKey}`.execute(
      db,
    )
  ).rows;
}
