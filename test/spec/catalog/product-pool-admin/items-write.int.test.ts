import { expect, it } from 'vitest';
import {
  audit,
  fields,
  hoursFromNow,
  instant,
  itemRow,
  newPoolId,
  OFF_SHELF_REASON,
  product,
  rejected,
  searchAnswers,
  seedItem,
  seedPool,
  seedRef,
  send,
  setup,
  snapshot,
  stableId,
  success,
  union,
  useHarness,
  type Item,
  type ItemList,
  type Setup,
} from './kit.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';

const h = useHarness();

const offShelf = () => new UnionError('item_unavailable', 'synthetic off shelf', 'taobao');
const outage = () => new UnionError('upstream_unavailable', 'synthetic outage', 'taobao');
const STALE_MS = 7_200_000;

it('[AC-B1-05q#60] 条目列表 sort 升序再按 product_key，页码分页，含下架和窗口外的条目', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await seedItem(h, f, pool, 'tb:B', { sort: 5 });
  await seedItem(h, f, pool, 'tb:A', { sort: 5, status: 'offline', invalid_reason: '原因' });
  await seedItem(h, f, pool, 'tb:C', {
    sort: 1,
    start_at: hoursFromNow(f, -3),
    end_at: hoursFromNow(f, -2),
  });
  const all = await success<ItemList>(await send(f, 'listItems', { pool }));
  expect(all.items.map((i) => i.product_key)).toEqual(['tb:C', 'tb:A', 'tb:B']);
  expect(all).toMatchObject({ page: 1, page_size: 20, total: 3 });
  expect(all.items[1]).toMatchObject({ status: 'offline', invalid_reason: '原因' });
  const second = await success<ItemList>(
    await send(f, 'listItems', { pool }, undefined, { query: '?page=2&page_size=2' }),
  );
  expect(second.items.map((i) => i.product_key)).toEqual(['tb:B']);
  expect(second).toMatchObject({ page: 2, page_size: 2, total: 3 });
});

it('[AC-B1-05q#61] 条目列表按 status 筛选', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await seedItem(h, f, pool, 'tb:A');
  await seedItem(h, f, pool, 'tb:B', { status: 'offline' });
  const offline = await success<ItemList>(
    await send(f, 'listItems', { pool }, undefined, { query: '?status=offline' }),
  );
  expect(offline.items.map((i) => i.product_key)).toEqual(['tb:B']);
  expect(offline.total).toBe(1);
});

it('[AC-B1-05q#62] 价格字段是上次成功刷新的值，读列表不问联盟', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const quoted = new Date(f.clock.now().getTime() - 7_200_000);
  await seedItem(h, f, pool, 'tb:A', { quoted_at: quoted });
  f.clock.advanceMs(1000);
  const before = await snapshot(h, f.appId);
  const list = await success<ItemList>(await send(f, 'listItems', { pool }));
  expect(list.items[0]).toMatchObject({ price_fen: 8800, coupon_fen: 800, final_price_fen: 8000 });
  expect(instant(list.items[0]!.quoted_at)).toBe(quoted.toISOString());
  expect(union.getItem).not.toHaveBeenCalled();
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#63] 条目列表 page_size 201 → fields=[page_size]；未知池 → 30701', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await fields(await send(f, 'listItems', { pool }, undefined, { query: '?page_size=201' }), [
    'page_size',
  ]);
  for (const target of [newPoolId(), pool.toUpperCase()]) {
    await rejected(await send(f, 'listItems', { pool: target }), 30701);
  }
});

it('[AC-B1-05q#64] 改顺序和窗口不问联盟，null 表示不限，同事务写 before / after 审计', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await seedItem(h, f, pool, 'tb:A', { sort: 1, end_at: hoursFromNow(f, 24) });
  f.clock.advanceMs(1000);
  const before = await snapshot(h, f.appId);
  const start = hoursFromNow(f, 1);
  const change = { sort: 2, start_at: start, end_at: null };
  const item = await success(await send(f, 'updateItem', { pool, key: 'tb:A' }, change));
  expect(item).toMatchObject({ product_key: 'tb:A', sort: 2, end_at: null, status: 'online' });
  expect(instant(item.start_at)).toBe(start);
  expect(instant(item.updated_at)).toBe(f.clock.now().toISOString());
  expect(union.getItem).not.toHaveBeenCalled();
  const entry = await audit(h, f, before, 'pool_item_update');
  expect(entry.before).toMatchObject({ product_key: 'tb:A', sort: 1 });
  expect(entry.after).toMatchObject({ product_key: 'tb:A', sort: 2 });
});

it('[AC-B1-05q#65] 空 body → fields=[body]，不写入', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await seedItem(h, f, pool, 'tb:A');
  const before = await snapshot(h, f.appId);
  await fields(await send(f, 'updateItem', { pool, key: 'tb:A' }, {}), ['body']);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it.each([
  { name: '只改 start_at 越过已有 end_at', body: 'start' },
  { name: '只改 end_at 早于已有 start_at', body: 'end' },
] as const)('[AC-B1-05q#66] 改后窗口不成立（$name）→ fields=[end_at]，不写入', async ({ body }) => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await seedItem(h, f, pool, 'tb:A', {
    start_at: hoursFromNow(f, 1),
    end_at: hoursFromNow(f, 2),
  });
  const before = await snapshot(h, f.appId);
  const change =
    body === 'start' ? { start_at: hoursFromNow(f, 2) } : { end_at: hoursFromNow(f, 1) };
  await fields(await send(f, 'updateItem', { pool, key: 'tb:A' }, change), ['end_at']);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#67] 手动 status=offline 立即下架，不问联盟，invalid_reason 仍为空', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await seedItem(h, f, pool, 'tb:A');
  f.clock.advanceMs(1000);
  const before = await snapshot(h, f.appId);
  expect(
    await success(await send(f, 'updateItem', { pool, key: 'tb:A' }, { status: 'offline' })),
  ).toMatchObject({ status: 'offline', invalid_reason: null });
  expect(union.getItem).not.toHaveBeenCalled();
  await audit(h, f, before, 'pool_item_update');
});

/** 下架的条目。默认有新鲜的 product_refs，原串与条目相同：复核无论取哪处都问到同一件商品。 */
async function offlineItem(f: Setup, reason: string = OFF_SHELF_REASON) {
  const { pool, stable, key, raw } = await staleOfflineItem(f, reason, 0);
  await seedRef(h, f, key, { raw_item_id: raw });
  f.clock.advanceMs(1000);
  return { pool, stable, key, raw };
}
/** 下架的条目，报价已是 ageMs 之前，没有 product_refs；不拨钟，后台会话 30 分钟无请求就失效。 */
async function staleOfflineItem(f: Setup, reason: string, ageMs: number) {
  const pool = await seedPool(h, f);
  const stable = stableId();
  const key = `tb:${stable}`;
  const raw = `rawA-${stable}`;
  await seedItem(h, f, pool, key, {
    status: 'offline',
    invalid_reason: reason,
    quoted_at: new Date(f.clock.now().getTime() - ageMs),
  });
  return { pool, stable, key, raw };
}
const usedRaws = () => union.getItem.mock.calls.map(([ref]) => ref.item_id);

it('[AC-B1-05q#68] 重新上架先复核：通过则 online，清原因并刷新价格', async () => {
  const f = await setup(h);
  const { pool, stable, key } = await offlineItem(f);
  const fresh = product(f, stable, {
    price_fen: 5000n,
    coupon_fen: 500n,
    final_price_fen: 4500n,
  });
  union.getItem.mockResolvedValue(fresh);
  const before = await snapshot(h, f.appId);
  const item = await success(await send(f, 'updateItem', { pool, key }, { status: 'online' }));
  expect(item).toMatchObject({
    status: 'online',
    invalid_reason: null,
    price_fen: 5000,
    coupon_fen: 500,
    final_price_fen: 4500,
  });
  expect(instant(item.quoted_at)).toBe(fresh.quoted_at);
  expect(union.getItem).toHaveBeenCalledTimes(1);
  await audit(h, f, before, 'pool_item_update');
});

it('[AC-B1-05q#69] 重新上架复核不通过：200，仍 offline 且带原因，价格不动', async () => {
  const f = await setup(h);
  const { pool, key } = await offlineItem(f, '上一次的原因');
  union.getItem.mockRejectedValue(offShelf());
  expect(
    await success(await send(f, 'updateItem', { pool, key }, { status: 'online' })),
  ).toMatchObject({
    status: 'offline',
    invalid_reason: OFF_SHELF_REASON,
    price_fen: 8800,
    final_price_fen: 8000,
  });
});

it('[AC-B1-05q#70] 重新上架时联盟答不了 → 50401，同一请求里的其他改动也不生效', async () => {
  const f = await setup(h);
  const { pool, key } = await offlineItem(f);
  union.getItem.mockRejectedValue(outage());
  const before = await snapshot(h, f.appId);
  await rejected(await send(f, 'updateItem', { pool, key }, { status: 'online', sort: 9 }), 50401);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#71] 对已 online 的条目传 status=online 不复核', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await seedItem(h, f, pool, 'tb:A');
  expect(
    await success(await send(f, 'updateItem', { pool, key: 'tb:A' }, { status: 'online' })),
  ).toMatchObject({ status: 'online' });
  expect(union.getItem).not.toHaveBeenCalled();
});

it('[AC-B1-05q#72] 复核用新鲜原串：条目里的原串已过期时走 product_refs，不用过期原串（BR-PROD-05）', async () => {
  const f = await setup(h);
  const { pool, stable, key, raw } = await staleOfflineItem(f, OFF_SHELF_REASON, STALE_MS);
  const fresh = `freshA-${stable}`;
  await seedRef(h, f, key, { raw_item_id: fresh });
  union.getItem.mockResolvedValue(product(f, stable, { item_id: fresh }));
  await success(await send(f, 'updateItem', { pool, key }, { status: 'online' }));
  expect(usedRaws()).toEqual([fresh]);
  expect(usedRaws()).not.toContain(raw);
});

it('[AC-B1-05q#73] 复核取不到新鲜原串也搜不到同键：200 仍 offline 带原因，不用过期原串', async () => {
  const f = await setup(h);
  const { pool, key, raw } = await staleOfflineItem(f, OFF_SHELF_REASON, STALE_MS);
  searchAnswers([[]]);
  const item = await success(await send(f, 'updateItem', { pool, key }, { status: 'online' }));
  expect(item.status).toBe('offline');
  expect(item.invalid_reason).toEqual(expect.any(String));
  expect(item.invalid_reason).not.toBe('');
  expect(usedRaws()).not.toContain(raw);
});

it('[AC-B1-05q#74] 改不存在的池或不在池里的商品 → 30701，不写入', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await seedItem(h, f, pool, 'tb:A');
  const other = await seedPool(h, f);
  const before = await snapshot(h, f.appId);
  for (const target of [
    { pool: newPoolId(), key: 'tb:A' },
    { pool: pool.toUpperCase(), key: 'tb:A' },
    { pool, key: 'tb:Missing' },
    { pool: other, key: 'tb:A' },
  ]) {
    await rejected(await send(f, 'updateItem', target, { sort: 3 }), 30701);
  }
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#75] 移除返回被删的行，product_refs 保留，同事务一条审计', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await seedItem(h, f, pool, 'tb:A', { sort: 4 });
  await seedItem(h, f, pool, 'tb:B');
  await seedRef(h, f, 'tb:A');
  f.clock.advanceMs(1000);
  const before = await snapshot(h, f.appId);
  expect(await success<Item>(await send(f, 'removeItem', { pool, key: 'tb:A' }))).toMatchObject({
    product_key: 'tb:A',
    sort: 4,
  });
  const entry = await audit(h, f, before, 'pool_item_remove');
  expect(entry.before ?? entry.after).toMatchObject({ product_key: 'tb:A', sort: 4 });
  const state = await snapshot(h, f.appId);
  expect(state.items.map((i) => i.product_key)).toEqual(['tb:B']);
  expect(state.refs).toEqual(before.refs);
});

it('[AC-B1-05q#76] 响应丢失后重试移除 → 30701，什么都不变', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await seedItem(h, f, pool, 'tb:A');
  await success<Item>(await send(f, 'removeItem', { pool, key: 'tb:A' }));
  const before = await snapshot(h, f.appId);
  await rejected(await send(f, 'removeItem', { pool, key: 'tb:A' }), 30701);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#77] 移除不存在的池或不在池里的商品 → 30701，不写入', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  await seedItem(h, f, pool, 'tb:A');
  const before = await snapshot(h, f.appId);
  for (const target of [
    { pool: newPoolId(), key: 'tb:A' },
    { pool: pool.toUpperCase(), key: 'tb:A' },
    { pool, key: 'tb:Missing' },
  ]) {
    await rejected(await send(f, 'removeItem', target), 30701);
  }
  expect(await snapshot(h, f.appId)).toEqual(before);
  expect(await itemRow(h, f, pool, 'tb:A')).toBeDefined();
});
