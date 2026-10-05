// F1-02b public contract (all tests import content/index.ts, never its internals):
// createContentReader({ db: Kysely<DB>, clock: Clock }) -> ContentReader.
// minSupportedVersion(appId: string, platform: ClientPlatform, channel: string) -> Promise<string | null>;
// configValue(appId: string, key: string) -> Promise<{ value: JSON, version: number } | null>.
// appId 由调用方传入（token 的 app_id，或经 BR-ID-01 ③ 校验过的 X-App-Id）。
//
// Sources: 02 §10; 04 §3.2 config_items/app_versions; BR-ID-01 minimum-version decision.
// Local choices where 02 §10 leaves refresh unspecified: configuration TTL 60,000 ms
// since the last successful load/revalidation, expiration at age >= TTL, injected Clock only.
// Cache hits do not extend TTL. At refresh, a changed version replaces value and version
// together. Missing keys may be
// cached for at most the same TTL. Read failures reject with an Error, never null/stale data;
// failure does not renew freshness, and the next call may recover immediately.
// 最低版本要么不缓存，要么与配置用同样的过期规则（age >= TTL 就重读）。
// No HTTP, guard, version comparison, config write API, or app.module wiring is specified here.
//
// ADR-0001 §4.2 #11 at SPEC_REF reserves dbRead for admin reports, contrary to task §9 #5's
// suggestion to prefer it. Inject the primary db here; orchestration must reconcile that text.
// Helpers follow platform/idempotency's per-file database + couli_app pattern. The referenced
// identity/devices kit does not exist at this checkout; no existing test assets are changed.
import type { DB } from '@couli/db';
import { sql, type Kysely, type KyselyPlugin, type RootOperationNode } from 'kysely';

export const START = '2031-05-06T07:08:09.000Z';
export const CACHE_MS = 60_000;
export type Json = DB['config_items']['value'];

let sequence = 0;

export async function seedVersion(
  db: Kysely<DB>,
  appId: string,
  platform: string,
  channel: string,
  minimum: string | null,
): Promise<void> {
  sequence += 1;
  await db
    .insertInto('app_versions')
    .values({
      id: `0199a3b4-5c6d-7000-8000-${sequence.toString(16).padStart(12, '0')}`,
      app_id: appId,
      platform,
      channel,
      latest_version: '99.0.0',
      min_supported_version: minimum,
      recommended_version: '88.0.0',
      update_title: '测试更新',
      update_notes: '最低版本查询夹具',
      store_url: 'https://store.example.test/app',
      default_store: 'appstore',
      store_listings: sql`'[]'::jsonb`,
      created_at: START,
      updated_at: START,
    })
    .execute();
}

export async function seedConfig(
  db: Kysely<DB>,
  appId: string,
  key: string,
  value: Json,
  version: number,
): Promise<void> {
  await db
    .insertInto('config_items')
    .values({
      app_id: appId,
      key,
      value: sql`${JSON.stringify(value)}::jsonb`,
      version,
      row_version: 27,
      updated_by: 'content-read-rule-test',
      created_at: START,
      updated_at: START,
    })
    .execute();
}

export async function changeConfig(
  db: Kysely<DB>,
  appId: string,
  key: string,
  value: Json,
  version: number,
): Promise<void> {
  await db
    .updateTable('config_items')
    .set({
      value: sql`${JSON.stringify(value)}::jsonb`,
      version,
      row_version: sql`row_version + 1`,
      updated_at: START,
    })
    .where('app_id', '=', appId)
    .where('key', '=', key)
    .execute();
}

/** Observe only service queries, not fixture writes; fault injection needs no network outage. */
export function observeQueries(db: Kysely<DB>) {
  const queries: RootOperationNode[] = [];
  const state: { failure: Error | null } = { failure: null };
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      queries.push(node);
      if (state.failure !== null) throw state.failure;
      return node;
    },
    transformResult({ result }) {
      return Promise.resolve(result);
    },
  };
  return { db: db.withPlugin(plugin), queries, state };
}
