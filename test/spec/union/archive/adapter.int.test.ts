import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { CallCtx } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { createArchivingTransport } from '../../../../apps/api/src/modules/union/infra/archive.ts';
import { PddUnionAdapter } from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { endpoint, req, TestIdentity, convertReply, authorityReply } from '../pdd-convert/kit.ts';
import { envelope, ref, row as goodsRow } from '../pdd-goods/kit.ts';
import { incrementReply, row as orderRow, detailRow, win } from '../pdd-orders/kit.ts';
import { harness, outcome, response, rows } from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app') });
});
afterAll(async () => {
  if (db) await destroyDb(db);
  if (database) await database.drop();
});

const cases = [
  ['search', 'query', 'pdd.ddk.goods.search'],
  ['detail', 'query', 'pdd.ddk.goods.detail'],
  ['feed', 'query', 'pdd.ddk.goods.recommend.get'],
  ['convert', 'convert', 'pdd.ddk.goods.promotion.url.generate'],
  ['authority', 'authority', 'pdd.ddk.member.authority.query'],
  ['authorityUrl', 'authority', 'pdd.ddk.rp.prom.url.generate'],
  ['increment', 'order', 'pdd.ddk.order.list.increment.get'],
  ['range', 'order', 'pdd.ddk.order.list.range.get'],
  ['orderDetail', 'order', 'pdd.ddk.order.detail.get'],
] as const;
type Operation = (typeof cases)[number][0];

function reply(operation: Operation, method: string): unknown {
  if (operation === 'convert') return convertReply();
  if (operation === 'authority') return { authority_query_response: { bind: 1 } };
  if (operation === 'authorityUrl') return authorityReply();
  if (operation === 'orderDetail') return { order_detail_response: detailRow() };
  if (operation === 'increment' || operation === 'range')
    return { order_list_get_response: { order_list: [] } };
  return envelope(method, [goodsRow()]);
}

function invoke(adapter: PddUnionAdapter, operation: Operation, ctx: CallCtx) {
  const who = new TestIdentity(undefined, { appId: ctx.appId });
  switch (operation) {
    case 'search':
      return adapter.searchItems({ keyword: '合成商品' }, ctx);
    case 'detail':
      return adapter.getItem(ref, ctx);
    case 'feed':
      return adapter.materialFeed({}, ctx);
    case 'convert':
      return adapter.convert(req, who, ctx);
    case 'authority':
      return adapter.queryPddAuthority(who, ctx);
    case 'authorityUrl':
      return adapter.pddAuthorityUrl(who, ctx);
    case 'increment':
      return adapter.listOrders(win, {}, ctx);
    case 'range':
      return adapter.listOrders(win, { queryMode: 'pay_time' }, ctx);
    case 'orderDetail':
      return adapter.getPddOrderDetail('synthetic-order-123456', ctx);
  }
}

function adapterFor(h: ReturnType<typeof harness>, inner: UnionTransport) {
  return new PddUnionAdapter({
    endpoint,
    clock: h.clock,
    credentials: async () => ({ clientId: 'fake-client', clientSecret: 'fake-pass!' }),
    queryIdentity: async () => ({
      pid: 'fake-query-pid',
      customParameters: '{"uid":"fake-query"}',
    }),
    transport: createArchivingTransport(inner, h),
  });
}

it.each(cases)(
  '[AC-B1-04p-ADAPTER#1] %s 每次请求写入 ctx.appId / %s；请求方法 %s 不丢上下文',
  async (operation, kind, method) => {
    const h = harness(db);
    const body = JSON.stringify(reply(operation, method));
    const inner = vi.fn<UnionTransport>(async () => response(body));
    const adapter = adapterFor(h, inner);
    for (const appId of [h.appId, `${h.appId}-other`]) {
      const result = await outcome(() =>
        invoke(adapter, operation, {
          appId,
          requestId: 'fake-request',
          purpose: 'online',
          headers: { appId: 'forged-app' },
        }),
      );
      expect(result).not.toBeInstanceOf(Error);
      const stored = await rows(db, appId);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ app_id: appId, platform: 'pdd', kind });
      expect(stored[0]!.request_summary).toMatchObject({ params: { type: method } });
      expect(gunzipSync(stored[0]!.payload).toString()).toBe(body);
      expect(inner.mock.calls.at(-1)?.[0]).toMatchObject({ archive: { appId, kind } });
    }
    expect(inner).toHaveBeenCalledTimes(2);
    expect(h.logger.warn).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04p-ADAPTER#2] listOrders 探尾页、倒序翻页：实际每个请求一行，缓存不重复归档', async () => {
  const h = harness(db);
  const dataset = Array.from({ length: 51 }, (_, i) =>
    orderRow({ order_sn: `synthetic-order-${i}` }),
  );
  const bodies: string[] = [];
  const inner = vi.fn<UnionTransport>(async (input) => {
    const body = JSON.stringify(
      incrementReply(dataset)(JSON.parse(input.body!) as Record<string, unknown>),
    );
    bodies.push(body);
    h.clock.advanceMs(11);
    return response(body);
  });
  const adapter = adapterFor(h, inner);
  const ctx: CallCtx = {
    appId: h.appId,
    requestId: 'fake-orders',
    purpose: 'order_sync',
    gateUpstream: (run) => run(new AbortController().signal),
  };
  let cursor: string | undefined;
  let count = 0;
  for (let i = 0; i < 4; i++) {
    const page = await adapter.listOrders(win, cursor === undefined ? {} : { cursor }, ctx);
    count += page.items.length;
    const stored = await rows(db, h.appId);
    expect(stored).toHaveLength(inner.mock.calls.length);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  expect(count).toBe(51);
  expect(inner.mock.calls.length).toBeGreaterThan(1);
  const stored = await rows(db, h.appId);
  expect(stored.map((entry) => gunzipSync(entry.payload).toString())).toEqual(bodies);
  for (const entry of stored)
    expect(entry).toMatchObject({ app_id: h.appId, kind: 'order', latency_ms: 11 });
  for (const [input] of inner.mock.calls)
    expect(input).toMatchObject({ archive: { appId: h.appId, kind: 'order' } });
});

it('[AC-B1-04p-ADAPTER#3] resolveLink 搜索、短链展开、再次搜索分别归档 query', async () => {
  const h = harness(db);
  const bodies = [
    JSON.stringify(envelope('pdd.ddk.goods.search', [])),
    JSON.stringify({ url: { url: 'https://synthetic.invalid/expanded' } }),
    JSON.stringify(envelope('pdd.ddk.goods.search', [goodsRow()])),
  ];
  let index = 0;
  const inner = vi.fn<UnionTransport>(async () => response(bodies[index++]!));
  const adapter = adapterFor(h, inner);
  const result = await outcome(() =>
    adapter.resolveLink('https://synthetic.invalid/short', {
      appId: h.appId,
      requestId: 'fake-link',
      purpose: 'online',
    }),
  );
  expect(result).not.toBeInstanceOf(Error);
  expect(inner).toHaveBeenCalledTimes(3);
  const stored = await rows(db, h.appId);
  expect(stored).toHaveLength(3);
  expect(stored.map((entry) => gunzipSync(entry.payload).toString())).toEqual(bodies);
  for (const entry of stored) expect(entry).toMatchObject({ app_id: h.appId, kind: 'query' });
  expect(stored[1]!.request_summary).toMatchObject({ params: { type: 'pdd.ddk.url.short.parse' } });
});
