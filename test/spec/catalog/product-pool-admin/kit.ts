// B1-05q：只经真实 admin 入口验收 CT-07d 的 9 个操作，不注册测试路由、不替换用例。
// 联盟只用演示适配器的规范化 DTO（DemoUnionAdapter 原型上打桩），不伪造平台报文。
// 每个用例独立 app_id，不清表；所有连接仅供容器内集成测试。
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import { sql, type Insertable } from 'kysely';
import { expect, vi } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import {
  DemoUnionAdapter,
  type ItemRef,
  type UnionItem,
  type UnionItemDetail,
} from '../../../../apps/api/src/modules/union/index.ts';
import { grant, seed } from '../../admin/accounts/kit.ts';
import {
  apiRequire,
  fixture,
  signedIn,
  type Harness,
  type Response,
  useHarness,
} from '../../admin/auth/kit.ts';

// specs/link-patterns.yaml 当前为空：只替换只读的形态表数据，分类与解析保持真实。
vi.mock('../../../../apps/api/src/modules/platform/specs/link-patterns.ts', () => ({
  getLinkPatterns: () => ({
    version: 'b1_05q_demo',
    rules: [
      { platform: 'taobao', category: 'union_host', hosts: ['demo.invalid'], path_patterns: [] },
      {
        platform: 'taobao',
        category: 'product',
        hosts: ['demo.invalid'],
        path_patterns: ['/taobao/*'],
      },
      { platform: 'jd', category: 'product', hosts: ['demo.invalid'], path_patterns: ['/jd/*'] },
      { platform: 'pdd', category: 'product', hosts: ['demo.invalid'], path_patterns: ['/pdd/*'] },
    ],
  }),
}));
const faults = vi.hoisted(() => ({ auditApps: new Set<string>() }));
// Test files run in parallel over one Redis and each fixture restarts its clock, so the real union
// bucket can run dry between files; quota is not what this suite tests.
vi.mock('../../../../apps/api/src/modules/union/application/shared-quota.ts', async (original) => ({
  ...(await original<
    typeof import('../../../../apps/api/src/modules/union/application/shared-quota.ts')
  >()),
  createUnionQuotaSource: () => ({
    limiter: (config: { readonly bucketKey: string }) => ({
      bucketKey: config.bucketKey,
      tryAcquire: () => true,
    }),
  }),
}));
vi.mock('../../../../apps/api/src/modules/admin/infra/audit-writer.ts', async (original) => {
  const actual =
    await original<typeof import('../../../../apps/api/src/modules/admin/infra/audit-writer.ts')>();
  return {
    ...actual,
    createAuditWriter: (deps: Parameters<typeof actual.createAuditWriter>[0]) => {
      const writer = actual.createAuditWriter(deps);
      return {
        append: async (input: Parameters<typeof writer.append>[0]) => {
          await writer.append(input);
          const pool = input.action.startsWith('product_pool_');
          if (
            faults.auditApps.has(input.appId) &&
            (pool || input.action.startsWith('pool_item_'))
          ) {
            throw new Error('synthetic pool audit failure');
          }
        },
      };
    },
  };
});
export function failAudit(appId: string) {
  faults.auditApps.add(appId);
}

// A plain import, not export-from: only import declarations stay after the vi.mock calls above.
export { useHarness };
export type { Harness };
export type Pool = Schema<'AdminProductPool'>;
export type PoolList = Schema<'AdminProductPoolList'>;
export type Item = Schema<'AdminPoolItem'>;
export type ItemList = Schema<'AdminPoolItemList'>;
export type Candidate = Schema<'AdminPoolCandidate'>;
export type CandidateList = Schema<'AdminPoolCandidateList'>;

export const PERMISSION = 'content.pool';
/** BR-PROD-05 ①：联盟明确下架时运营看到的原因。 */
export const OFF_SHELF_REASON = '联盟返回下架';
export const RAW_MAX_AGE_MS = 1_800_000;

const BASE = '/admin/v1/product-pools';
export const ROUTES = {
  listPools: { method: 'GET', path: BASE, id: 'adminListProductPools' },
  createPool: { method: 'POST', path: BASE, id: 'adminCreateProductPool' },
  candidates: { method: 'GET', path: `${BASE}/candidates`, id: 'adminSearchPoolCandidates' },
  getPool: { method: 'GET', path: `${BASE}/{pool_id}`, id: 'adminGetProductPool' },
  updatePool: { method: 'PATCH', path: `${BASE}/{pool_id}`, id: 'adminUpdateProductPool' },
  listItems: { method: 'GET', path: `${BASE}/{pool_id}/items`, id: 'adminListPoolItems' },
  addItem: { method: 'POST', path: `${BASE}/{pool_id}/items`, id: 'adminAddPoolItem' },
  updateItem: {
    method: 'PATCH',
    path: `${BASE}/{pool_id}/items/{product_key}`,
    id: 'adminUpdatePoolItem',
  },
  removeItem: {
    method: 'DELETE',
    path: `${BASE}/{pool_id}/items/{product_key}`,
    id: 'adminRemovePoolItem',
  },
} as const;
export type Operation = keyof typeof ROUTES;

export const union = {
  getItem: vi.spyOn(DemoUnionAdapter.prototype, 'getItem'),
  resolveLink: vi.spyOn(DemoUnionAdapter.prototype, 'resolveLink'),
  searchItems: vi.spyOn(DemoUnionAdapter.prototype, 'searchItems'),
  materialFeed: vi.spyOn(DemoUnionAdapter.prototype, 'materialFeed'),
  channelRanking: vi.spyOn(DemoUnionAdapter.prototype, 'channelRanking'),
  convert: vi.spyOn(DemoUnionAdapter.prototype, 'convert'),
};

function uniqueApp(): string {
  return `b1_05q_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

/** 候选搜索要的开关、演示报价配置和 query 推广位，只造数据，不碰业务写入路径。 */
async function seedUnionAccess(h: Harness, appId: string, now: Date) {
  const by = 'synthetic-b1-05q';
  await h.db
    .insertInto('config_items')
    .values([
      { app_id: appId, key: 'search.enabled.taobao', value: true, updated_by: by },
      { app_id: appId, key: 'search.enabled.pdd', value: true, updated_by: by },
      { app_id: appId, key: 'tech_fee_bp', value: { taobao: 0, jd: 0, pdd: 0 }, updated_by: by },
      { app_id: appId, key: 'rebate.taobao.compare_rate_ratio_bp', value: 5000, updated_by: by },
      {
        app_id: appId,
        key: 'demo.rebate_quote_rule',
        value: { reserve_bp: 0, self_share_bp: 10000 },
        updated_by: by,
      },
    ])
    .execute();
  for (const platform of ['taobao', 'pdd']) {
    const account = randomUUID();
    await h.db
      .insertInto('union_accounts')
      .values({
        id: account,
        app_id: appId,
        platform,
        account_name: by,
        status: 'active',
        auth_status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await h.db
      .insertInto('union_pids')
      .values({
        id: randomUUID(),
        app_id: appId,
        platform,
        union_account_id: account,
        site_id: platform === 'taobao' ? 'synthetic-site' : null,
        pid: `synthetic-pid-${platform}`,
        pid_scene: 'query',
        status: 'active',
        hjy_ignore_confirmed_at: now,
        hjy_ignore_evidence_path: 'https://example.test/pool-evidence',
        created_at: now,
        updated_at: now,
      })
      .execute();
  }
}

export type KeyStability = 'unverified' | 'stable_24h' | 'stable_7d' | 'unstable';
/** platforms 是全库字典，不分 App；迁移 0017 的种子一律 unverified。 */
export async function setKeyStability(h: Harness, clock: { now(): Date }, stability: KeyStability) {
  await h.db
    .updateTable('platforms')
    .set({ key_stability: stability, updated_at: clock.now() })
    .where('code', 'in', ['taobao', 'jd', 'pdd'])
    .execute();
}

export async function setup(h: Harness) {
  const f = await fixture(h);
  const server = f.app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  // 未实现时每个用例都由断言变红，包括负向用例，不能误吃全局 404 / 校验错误。
  for (const route of Object.values(ROUTES)) {
    expect(
      server.hasRoute({ method: route.method, url: route.path.replace(/\{(\w+)\}/g, ':$1') }),
      route.id,
    ).toBe(true);
  }
  for (const spy of Object.values(union)) spy.mockReset();
  // 全套用例跑在种子值上：S0 验证前商品池也要能用（BR-PROD-03 功能门槛）；改过值的用例在此复位。
  await setKeyStability(h, f.clock, 'unverified');
  const appId = uniqueApp();
  const owner = await seed(h, appId, { isSuper: true });
  const actor = await seed(h, appId);
  await grant(h, actor, owner, [PERMISSION]);
  const session = await signedIn(f, actor);
  await seedUnionAccess(h, appId, f.clock.now());
  return { ...f, appId, owner, actor, token: session.admin_token };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

export async function member(h: Harness, f: Setup, permissions: readonly string[]) {
  const account = await seed(h, f.appId);
  if (permissions.length > 0) await grant(h, account, f.owner, permissions);
  const session = await signedIn(f, account);
  return { account, token: session.admin_token };
}

/** 同一进程里的第二个 App：池与条目按 app_id 隔离。 */
export async function otherApp(h: Harness, f: Setup): Promise<Setup> {
  const appId = uniqueApp();
  const owner = await seed(h, appId, { isSuper: true });
  const actor = await seed(h, appId);
  await grant(h, actor, owner, [PERMISSION]);
  const session = await signedIn(f, actor);
  await seedUnionAccess(h, appId, f.clock.now());
  return { ...f, appId, owner, actor, token: session.admin_token };
}

interface InjectApp {
  inject(input: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    headers: Record<string, string>;
    payload?: string;
    remoteAddress: string;
  }): Promise<Response>;
}
export interface Sent {
  response: Response;
  trace: string;
  op: Operation;
}
export interface Target {
  pool?: string;
  key?: string;
}
export async function send(
  f: Pick<Setup, 'app' | 'token'>,
  op: Operation,
  target: Target = {},
  body?: Record<string, unknown>,
  options: { query?: string; token?: string | null } = {},
): Promise<Sent> {
  const route = ROUTES[op];
  const token = options.token === undefined ? f.token : options.token;
  const trace = randomUUID();
  const response = await (f.app as unknown as InjectApp).inject({
    method: route.method,
    url:
      route.path
        .replace('{pool_id}', encodeURIComponent(target.pool ?? ''))
        .replace('{product_key}', encodeURIComponent(target.key ?? '')) + (options.query ?? ''),
    headers: {
      'x-trace-id': trace,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    remoteAddress: '127.0.0.1',
  });
  return { response, trace, op };
}

interface ContractOperation {
  operationId: string;
  parameters?: { name: string }[];
  responses: Record<string, { content: Record<string, { schema: JsonSchema }> }>;
}
export async function contract() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{
      paths: Record<string, Record<string, ContractOperation>>;
    }>;
  };
  return parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
}
type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let validators: Promise<Map<string, Validator>> | undefined;
async function validate(sent: Sent) {
  validators ??= (async () => {
    const doc = await contract();
    const compile = createValidatorCompiler();
    const result = new Map<string, Validator>();
    for (const [op, route] of Object.entries(ROUTES)) {
      for (const status of ['200', '4XX', '5XX']) {
        result.set(
          `${op}:${status}`,
          compile({
            schema:
              doc.paths[route.path]![route.method.toLowerCase()]!.responses[status]!.content[
                'application/json'
              ]!.schema,
            httpPart: 'body',
          }),
        );
      }
    }
    return result;
  })();
  const status =
    sent.response.statusCode < 400 ? '200' : sent.response.statusCode < 500 ? '4XX' : '5XX';
  const check = (await validators).get(`${sent.op}:${status}`)!;
  expect(check(sent.response.json()), JSON.stringify(check.errors)).toBe(true);
}

/** contracts/error-codes.yaml 的 http 列。 */
const HTTP: Readonly<Record<number, number>> = {
  10001: 401,
  10403: 403,
  20001: 400,
  20902: 409,
  30131: 422,
  30132: 422,
  30141: 422,
  30143: 422,
  30701: 404,
  50001: 500,
  50304: 503,
  50401: 504,
};
export async function success<T = Item>(sent: Sent): Promise<T> {
  expect(sent.response.statusCode, JSON.stringify(sent.response.json())).toBe(200);
  expect(sent.response.json()).toMatchObject({ code: 0, trace_id: sent.trace });
  await validate(sent);
  return sent.response.json<{ data: T }>().data;
}
export async function rejected(sent: Sent, code: number, data?: object) {
  expect(sent.response.statusCode, JSON.stringify(sent.response.json())).toBe(HTTP[code]);
  expect(sent.response.json()).toMatchObject({ code, trace_id: sent.trace });
  if (data !== undefined) expect(sent.response.json().data).toEqual(data);
  await validate(sent);
}
export async function fields(sent: Sent, expected: readonly string[]) {
  await rejected(sent, 20001);
  const data = sent.response.json<{ data: { fields: string[] } }>().data;
  expect([...data.fields].sort()).toEqual([...expected].sort());
}
export const conflict = (sent: Sent) => rejected(sent, 20902, { resource: 'product_pool' });

let sequence = 0;
export function newPoolId(): string {
  sequence += 1;
  return `0199f105-aaaa-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
}
export function stableId(prefix = 'K'): string {
  return `${prefix}${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}
export function instant(value: Date | string | null) {
  return value === null ? null : new Date(value).toISOString();
}
export function hoursFromNow(f: Pick<Setup, 'clock'>, hours: number): string {
  return new Date(f.clock.now().getTime() + hours * 3_600_000).toISOString();
}

/** 一件演示商品的规范化详情；淘宝的 key 取原串 `-` 后的最后一段（BR-PROD-03）。 */
export function product(
  f: Pick<Setup, 'clock'>,
  stable: string,
  extra: Partial<UnionItemDetail> = {},
): UnionItemDetail {
  return {
    platform: 'taobao',
    item_id: `rawA-${stable}`,
    title: `合成商品 ${stable}`,
    price_fen: 3990n,
    coupon_fen: 1000n,
    final_price_fen: 2990n,
    commission_rate_bp: 2000n,
    quoted_at: f.clock.now().toISOString(),
    ...extra,
  };
}
export const linkOf = (raw: string, platform = 'taobao') =>
  `https://demo.invalid/${platform}/${encodeURIComponent(raw)}`;

function refOf(item: ItemRef): ItemRef {
  return {
    platform: item.platform,
    ...(item.item_id === undefined ? {} : { item_id: item.item_id }),
    ...(item.itemId === undefined ? {} : { itemId: item.itemId }),
    ...(item.skuId === undefined ? {} : { skuId: item.skuId }),
    ...(item.goods_id === undefined ? {} : { goods_id: item.goods_id }),
    ...(item.goods_sign === undefined ? {} : { goods_sign: item.goods_sign }),
  };
}
/** 链接解析到这件商品，详情回这件商品的价格。 */
export function stubProduct(item: UnionItemDetail) {
  union.resolveLink.mockResolvedValue({ item: refOf(item) });
  union.getItem.mockResolvedValue(item);
}
/** 联盟搜索的分页：下标 0 是第一页，游标是演示自用的 page-<n>。 */
export function searchAnswers(pages: readonly (readonly UnionItem[])[]) {
  union.searchItems.mockImplementation((query) => {
    const index = query.cursor === undefined ? 0 : Number(query.cursor.slice('page-'.length));
    return Promise.resolve({
      items: pages[index] ?? [],
      nextCursor: index + 1 < pages.length ? `page-${String(index + 1)}` : null,
    });
  });
}

/** 走真实候选接口取 item_ref：query 每次不同，不命中 BR-PROD-07 搜索缓存。 */
export async function candidates(
  f: Setup,
  query: Record<string, string> = {},
  options: { token?: string } = {},
): Promise<Sent> {
  const search = new URLSearchParams({ platform: 'taobao', q: '合成', ...query });
  return send(f, 'candidates', {}, undefined, { ...options, query: `?${search.toString()}` });
}
export async function pick(f: Setup, item: UnionItemDetail): Promise<Candidate> {
  searchAnswers([[item]]);
  const list = await success<CandidateList>(await candidates(f, { q: `合成${stableId('q')}` }));
  expect(list.items).toHaveLength(1);
  return list.items[0]!;
}

export const bounds = (sort = 0, start: string | null = null, end: string | null = null) => ({
  sort,
  start_at: start,
  end_at: end,
});
type Bounds = ReturnType<typeof bounds>;
export const addLink = (f: Setup, pool: string, link: string, at: Bounds = bounds()) =>
  send(f, 'addItem', { pool }, { link_text: link, ...at });
export const addRef = (f: Setup, pool: string, ref: string, at: Bounds = bounds()) =>
  send(f, 'addItem', { pool }, { item_ref: ref, ...at });

/** 后台会话 30 分钟无请求即失效：分两段拨钟，中间走一次真实读续期，否则只会得到 10001。 */
export async function age(f: Setup, ms: number) {
  const half = Math.floor(ms / 2);
  f.clock.advanceMs(half);
  await success<PoolList>(await send(f, 'listPools'));
  f.clock.advanceMs(ms - half);
}

export async function seedPool(
  h: Harness,
  f: Setup,
  extra: Partial<Insertable<DB['product_pools']>> = {},
): Promise<string> {
  const id = extra.pool_id ?? newPoolId();
  await h.db
    .insertInto('product_pools')
    .values({
      app_id: f.appId,
      pool_id: id,
      name: '合成商品池',
      status: 'active',
      created_by: f.actor.id,
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
      ...extra,
    })
    .execute();
  return id;
}
export async function seedItem(
  h: Harness,
  f: Setup,
  pool: string,
  key: string,
  extra: Partial<Insertable<DB['pool_items']>> = {},
) {
  const stable = key.slice(key.indexOf(':') + 1);
  await h.db
    .insertInto('pool_items')
    .values({
      app_id: f.appId,
      pool_id: pool,
      product_key: key,
      platform: 'taobao',
      raw_item_id: `rawA-${stable}`,
      title: `入池时的标题 ${stable}`,
      price_fen: 8800n,
      coupon_fen: 800n,
      final_price_fen: 8000n,
      quoted_at: f.clock.now(),
      status: 'online',
      sort: 0,
      created_by: f.actor.id,
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
      ...extra,
    })
    .execute();
}
export async function seedRef(
  h: Harness,
  f: Setup,
  key: string,
  extra: Partial<Insertable<DB['product_refs']>> = {},
) {
  const stable = key.slice(key.indexOf(':') + 1);
  await h.db
    .insertInto('product_refs')
    .values({
      app_id: f.appId,
      product_key: key,
      platform: 'taobao',
      raw_item_id: `rawRef-${stable}`,
      raw_fetched_at: f.clock.now(),
      title: `合成商品 ${stable}`,
      source: 'search',
      refreshed_at: f.clock.now(),
      ...extra,
    })
    .execute();
}
export async function seedAlias(h: Harness, oldKey: string, newKey: string) {
  await sql`INSERT INTO app.product_key_aliases (old_key, new_key, reason, adr_id)
    VALUES (${oldKey}, ${newKey}, '一对一格式变更测试', 'ADR-test')`.execute(h.db);
}
export async function setConfig(h: Harness, f: Setup, key: string, value: unknown) {
  await h.db
    .insertInto('config_items')
    .values({
      app_id: f.appId,
      key,
      value: sql`${JSON.stringify(value)}::jsonb`,
      updated_by: 'synthetic-b1-05q',
    })
    .onConflict((oc) =>
      oc.columns(['app_id', 'key']).doUpdateSet({ value: sql`${JSON.stringify(value)}::jsonb` }),
    )
    .execute();
}

export async function snapshot(h: Harness, appId: string) {
  return {
    pools: await h.db
      .selectFrom('product_pools')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('pool_id')
      .execute(),
    items: await h.db
      .selectFrom('pool_items')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('pool_id')
      .orderBy('product_key')
      .execute(),
    refs: await h.db
      .selectFrom('product_refs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('product_key')
      .execute(),
    links: await h.db
      .selectFrom('links')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('link_id')
      .execute(),
    linkLogs: await h.db
      .selectFrom('link_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
    audits: await h.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('app_id', '=', appId)
      .orderBy('id')
      .execute(),
  };
}
export type Snapshot = Awaited<ReturnType<typeof snapshot>>;
export type Action =
  | 'product_pool_create'
  | 'product_pool_update'
  | 'pool_item_add'
  | 'pool_item_update'
  | 'pool_item_remove';

/** 本次写恰好多一条审计，返回它；admin_id 默认是 setup 的操作者。 */
export async function audit(
  h: Harness,
  f: Setup,
  before: Snapshot,
  action: Action,
  adminId: string = f.actor.id,
) {
  const after = await snapshot(h, f.appId);
  const ids = new Set(before.audits.map((a) => a.id));
  const added = after.audits.filter((a) => !ids.has(a.id));
  expect(added).toHaveLength(1);
  const row = added[0]!;
  expect(row).toMatchObject({ action, admin_id: adminId, app_id: f.appId, at: f.clock.now() });
  return row;
}
export function revisionOf(value: unknown): number {
  return Number((value as { revision: unknown }).revision);
}

export async function itemRow(h: Harness, f: Setup, pool: string, key: string) {
  return h.db
    .selectFrom('pool_items')
    .selectAll()
    .where('app_id', '=', f.appId)
    .where('pool_id', '=', pool)
    .where('product_key', '=', key)
    .executeTakeFirst();
}

/** 别的 App 的另一个池里也有这个 key，返回改动前的行：联盟下架不能越过 app_id。 */
export async function foreignItem(h: Harness, f: Setup, key: string) {
  const app = await otherApp(h, f);
  const pool = await seedPool(h, app);
  await seedItem(h, app, pool, key);
  return { app, pool, row: await itemRow(h, app, pool, key) };
}

/**
 * 两个请求都走到联盟应答后再一起放行，逼出真并发；实现若在调联盟前就串行化，超时后也会放行，
 * 用例不因此挂死。
 */
export function rendezvous(parties: number, waitMs = 1000): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) open();
    await Promise.race([gate, delay(waitMs)]);
  };
}
