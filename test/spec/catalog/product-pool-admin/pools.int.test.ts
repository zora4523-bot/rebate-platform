import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  audit,
  conflict,
  fields,
  instant,
  newPoolId,
  otherApp,
  rejected,
  revisionOf,
  seedItem,
  seedPool,
  send,
  setup,
  snapshot,
  success,
  useHarness,
  type Pool,
  type PoolList,
} from './kit.ts';

const h = useHarness();

it('[AC-B1-05q#2] 新建默认 active、revision 0，时间取 Clock，创建人是操作者，同事务一条审计', async () => {
  const f = await setup(h);
  const id = newPoolId();
  const before = await snapshot(h, f.appId);
  const pool = await success<Pool>(
    await send(f, 'createPool', {}, { pool_id: id, name: '首页爆款' }),
  );
  expect(pool).toMatchObject({ pool_id: id, name: '首页爆款', status: 'active', revision: 0 });
  expect(instant(pool.created_at)).toBe(f.clock.now().toISOString());
  expect(instant(pool.updated_at)).toBe(f.clock.now().toISOString());
  const state = await snapshot(h, f.appId);
  expect(state.pools).toHaveLength(1);
  expect(state.pools[0]).toMatchObject({
    app_id: f.appId,
    pool_id: id,
    status: 'active',
    created_by: f.actor.id,
    created_at: f.clock.now(),
    updated_at: f.clock.now(),
  });
  const row = await audit(h, f, before, 'product_pool_create');
  expect(row.after).toMatchObject({ pool_id: id, name: '首页爆款', status: 'active' });
  expect(revisionOf(row.after)).toBe(0);
});

it('[AC-B1-05q#3] 新建可显式带 status=disabled', async () => {
  const f = await setup(h);
  const id = newPoolId();
  expect(
    await success<Pool>(
      await send(f, 'createPool', {}, { pool_id: id, name: '备用池', status: 'disabled' }),
    ),
  ).toMatchObject({ pool_id: id, status: 'disabled', revision: 0 });
});

it('[AC-B1-05q#4] 同一 pool_id 重试返回 20902 且什么都不写', async () => {
  const f = await setup(h);
  const id = newPoolId();
  await success<Pool>(await send(f, 'createPool', {}, { pool_id: id, name: '首页爆款' }));
  const before = await snapshot(h, f.appId);
  f.clock.advanceMs(1000);
  await conflict(await send(f, 'createPool', {}, { pool_id: id, name: '换了名字' }));
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it.each([
  { name: '大写的 UUIDv7', id: () => newPoolId().toUpperCase() },
  { name: '小写的 UUIDv4', id: () => randomUUID() },
  { name: '不是 UUID', id: () => 'not-a-uuid' },
])('[AC-B1-05q#5] 新建 pool_id 是$name → 20001 fields=[pool_id]，不写入', async ({ id }) => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  await fields(await send(f, 'createPool', {}, { pool_id: id(), name: '首页爆款' }), ['pool_id']);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it.each([
  { label: '空串', name: '' },
  { label: '全空白', name: '   ' },
  { label: '超过 64 字符', name: '池'.repeat(65) },
])('[AC-B1-05q#6] 新建 name $label → 20001 fields=[name]，不写入', async ({ name }) => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  await fields(await send(f, 'createPool', {}, { pool_id: newPoolId(), name }), ['name']);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#7] 同一 pool_id 在两个 App 下是两个独立的池，互相读不到', async () => {
  const f = await setup(h);
  const other = await otherApp(h, f);
  const id = newPoolId();
  await success<Pool>(await send(f, 'createPool', {}, { pool_id: id, name: '甲 App 的池' }));
  await rejected(await send(other, 'getPool', { pool: id }), 30701);
  await success<Pool>(await send(other, 'createPool', {}, { pool_id: id, name: '乙 App 的池' }));
  expect(await success<Pool>(await send(f, 'getPool', { pool: id }))).toMatchObject({
    name: '甲 App 的池',
  });
  expect(await success<Pool>(await send(other, 'getPool', { pool: id }))).toMatchObject({
    name: '乙 App 的池',
  });
});

it('[AC-B1-05q#8] 列表新建在前、按 status 筛选、页码分页且 total 只算本 App', async () => {
  const f = await setup(h);
  const other = await otherApp(h, f);
  await seedPool(h, other);
  const at = (hours: number) => new Date(f.clock.now().getTime() - hours * 3_600_000);
  const oldest = await seedPool(h, f, { created_at: at(3) });
  const middle = await seedPool(h, f, { created_at: at(2), status: 'disabled' });
  const newest = await seedPool(h, f, { created_at: at(1) });
  const all = await success<PoolList>(await send(f, 'listPools'));
  expect(all.items.map((p) => p.pool_id)).toEqual([newest, middle, oldest]);
  expect(all).toMatchObject({ page: 1, page_size: 20, total: 3 });
  const second = await success<PoolList>(
    await send(f, 'listPools', {}, undefined, { query: '?page=2&page_size=2' }),
  );
  expect(second.items.map((p) => p.pool_id)).toEqual([oldest]);
  expect(second).toMatchObject({ page: 2, page_size: 2, total: 3 });
  const disabled = await success<PoolList>(
    await send(f, 'listPools', {}, undefined, { query: '?status=disabled' }),
  );
  expect(disabled.items.map((p) => p.pool_id)).toEqual([middle]);
  expect(disabled.total).toBe(1);
});

it('[AC-B1-05q#9] 列表 page_size 200 可用，201 → 20001 fields=[page_size]', async () => {
  const f = await setup(h);
  await success<PoolList>(await send(f, 'listPools', {}, undefined, { query: '?page_size=200' }));
  await fields(await send(f, 'listPools', {}, undefined, { query: '?page_size=201' }), [
    'page_size',
  ]);
});

it('[AC-B1-05q#10] 单个池带 revision；不存在、大写写法、非 UUID 都是 30701', async () => {
  const f = await setup(h);
  const id = await seedPool(h, f, { revision: 3n });
  expect(await success<Pool>(await send(f, 'getPool', { pool: id }))).toMatchObject({
    pool_id: id,
    revision: 3,
  });
  for (const pool of [newPoolId(), id.toUpperCase(), 'not-a-uuid']) {
    await rejected(await send(f, 'getPool', { pool }), 30701);
  }
});

it('[AC-B1-05q#11] 改名与启停各加一次 revision，created_at 不变，同事务写 before / after 审计', async () => {
  const f = await setup(h);
  const id = await seedPool(h, f, { revision: 3n });
  const created = f.clock.now();
  f.clock.advanceMs(1000);
  let before = await snapshot(h, f.appId);
  const renamed = await success<Pool>(
    await send(f, 'updatePool', { pool: id }, { name: '新名字', expected_revision: 3 }),
  );
  expect(renamed).toMatchObject({ name: '新名字', status: 'active', revision: 4 });
  expect(instant(renamed.updated_at)).toBe(f.clock.now().toISOString());
  expect(instant(renamed.created_at)).toBe(created.toISOString());
  const row = await audit(h, f, before, 'product_pool_update');
  expect(row.before).toMatchObject({ pool_id: id, name: '合成商品池', status: 'active' });
  expect(row.after).toMatchObject({ pool_id: id, name: '新名字', status: 'active' });
  expect(revisionOf(row.before)).toBe(3);
  expect(revisionOf(row.after)).toBe(4);
  before = await snapshot(h, f.appId);
  expect(
    await success<Pool>(
      await send(f, 'updatePool', { pool: id }, { status: 'disabled', expected_revision: 4 }),
    ),
  ).toMatchObject({ name: '新名字', status: 'disabled', revision: 5 });
  await audit(h, f, before, 'product_pool_update');
});

it('[AC-B1-05q#12] expected_revision 不符 → 20902 data.resource=product_pool，什么都不写', async () => {
  const f = await setup(h);
  const id = await seedPool(h, f, { revision: 2n });
  const before = await snapshot(h, f.appId);
  f.clock.advanceMs(1000);
  for (const revision of [1, 3]) {
    await conflict(
      await send(f, 'updatePool', { pool: id }, { name: '新名字', expected_revision: revision }),
    );
  }
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#13] 同 expected_revision 并发恰一成一败，只留一条审计', async () => {
  const f = await setup(h);
  const id = await seedPool(h, f);
  const before = await snapshot(h, f.appId);
  f.clock.advanceMs(1000);
  const attempts = await Promise.all(
    ['甲', '乙'].map((name) => send(f, 'updatePool', { pool: id }, { name, expected_revision: 0 })),
  );
  expect(attempts.map((s) => s.response.statusCode).sort()).toEqual([200, 409]);
  await conflict(attempts.find((s) => s.response.statusCode === 409)!);
  const winner = await success<Pool>(attempts.find((s) => s.response.statusCode === 200)!);
  expect(winner.revision).toBe(1);
  await audit(h, f, before, 'product_pool_update');
  expect((await snapshot(h, f.appId)).pools[0]).toMatchObject({ name: winner.name });
});

it.each([
  { label: '只有 expected_revision', body: { expected_revision: 0 }, expected: ['body'] },
  { label: 'name 全空白', body: { name: '   ', expected_revision: 0 }, expected: ['name'] },
  { label: 'name 空串', body: { name: '', expected_revision: 0 }, expected: ['name'] },
])('[AC-B1-05q#14] 改池时$label → 20001，不写入', async ({ body, expected }) => {
  const f = await setup(h);
  const id = await seedPool(h, f);
  const before = await snapshot(h, f.appId);
  await fields(await send(f, 'updatePool', { pool: id }, body), expected);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#15] 改不存在或大写写法的池 → 30701，不写入', async () => {
  const f = await setup(h);
  const id = await seedPool(h, f);
  const before = await snapshot(h, f.appId);
  for (const pool of [newPoolId(), id.toUpperCase()]) {
    await rejected(
      await send(f, 'updatePool', { pool }, { name: '新名字', expected_revision: 0 }),
      30701,
    );
  }
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#16] 停用的池保留全部条目', async () => {
  const f = await setup(h);
  const id = await seedPool(h, f);
  await seedItem(h, f, id, 'tb:K16');
  const before = await snapshot(h, f.appId);
  expect(
    await success<Pool>(
      await send(f, 'updatePool', { pool: id }, { status: 'disabled', expected_revision: 0 }),
    ),
  ).toMatchObject({ status: 'disabled' });
  expect((await snapshot(h, f.appId)).items).toEqual(before.items);
});
