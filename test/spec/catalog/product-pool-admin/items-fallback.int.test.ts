// BR-PROD-05：item_ref 过期后按 product_refs、重新解析回退，真找不到才 30143；过期原串绝不再用。
import { expect, it } from 'vitest';
import {
  addRef,
  age,
  bounds,
  itemRow,
  linkOf,
  pick,
  product,
  RAW_MAX_AGE_MS,
  rejected,
  searchAnswers,
  seedPool,
  seedRef,
  setup,
  snapshot,
  stableId,
  success,
  union,
  useHarness,
  type Setup,
} from './kit.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';

const h = useHarness();

const AGED = RAW_MAX_AGE_MS + 1000;

/** 拿到一张已过期的 item_ref，并清掉取它时的联盟调用记录。 */
async function agedRef(f: Setup) {
  const pool = await seedPool(h, f);
  const stable = stableId();
  const key = `tb:${stable}`;
  const stale = product(f, stable, { item_id: `staleA-${stable}` });
  const row = await pick(f, stale);
  expect(row.product_key).toBe(key);
  await age(f, AGED);
  union.searchItems.mockClear();
  union.getItem.mockClear();
  return { pool, stable, key, staleRaw: stale.item_id!, ref: row.item_ref };
}
const usedRaws = () => union.getItem.mock.calls.map(([ref]) => ref.item_id);

it('[AC-B1-05q#50] 取得后恰好 1800 秒仍算新鲜，用 item_ref 里的原串', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const stable = stableId();
  const item = product(f, stable);
  const row = await pick(f, item);
  await age(f, RAW_MAX_AGE_MS);
  union.getItem.mockClear();
  union.getItem.mockResolvedValue({ ...item, quoted_at: f.clock.now().toISOString() });
  await success(await addRef(f, pool, row.item_ref));
  expect(usedRaws()).toEqual([item.item_id]);
  expect(union.searchItems).toHaveBeenCalledTimes(1);
});

it('[AC-B1-05q#51] item_ref 过期、product_refs 新鲜：用 product_refs 的原串，不重新解析', async () => {
  const f = await setup(h);
  const { pool, stable, key, staleRaw, ref } = await agedRef(f);
  const raw = `freshA-${stable}`;
  await seedRef(h, f, key, { raw_item_id: raw });
  union.getItem.mockResolvedValue(product(f, stable, { item_id: raw }));
  await success(await addRef(f, pool, ref));
  expect(usedRaws()).toEqual([raw]);
  expect(usedRaws()).not.toContain(staleRaw);
  expect(union.searchItems).not.toHaveBeenCalled();
  expect(await itemRow(h, f, pool, key)).toMatchObject({ raw_item_id: raw });
});

it('[AC-B1-05q#52] 两处都过期且有 canonical_url：按链接解析出新原串', async () => {
  const f = await setup(h);
  const { pool, stable, key, staleRaw, ref } = await agedRef(f);
  const old = new Date(f.clock.now().getTime() - AGED);
  await seedRef(h, f, key, {
    raw_item_id: staleRaw,
    raw_fetched_at: old,
    refreshed_at: old,
    canonical_url: linkOf(staleRaw),
    source: 'parse',
  });
  const raw = `freshA-${stable}`;
  union.resolveLink.mockResolvedValue({ item: { platform: 'taobao', item_id: raw } });
  union.getItem.mockResolvedValue(product(f, stable, { item_id: raw }));
  await success(await addRef(f, pool, ref));
  expect(union.resolveLink).toHaveBeenCalledTimes(1);
  expect(usedRaws()).toEqual([raw]);
  expect(await itemRow(h, f, pool, key)).toMatchObject({ raw_item_id: raw });
});

it('[AC-B1-05q#53] 两处都过期：按标题搜第 1 页找到同键，用新原串入库并刷新 product_refs', async () => {
  const f = await setup(h);
  const { pool, stable, key, staleRaw, ref } = await agedRef(f);
  const old = new Date(f.clock.now().getTime() - AGED);
  const title = `旧标题 ${stable}`;
  await seedRef(h, f, key, {
    raw_item_id: staleRaw,
    raw_fetched_at: old,
    refreshed_at: old,
    title,
  });
  const raw = `freshA-${stable}`;
  const found = product(f, stable, { item_id: raw });
  searchAnswers([[product(f, stableId()), found]]);
  union.getItem.mockResolvedValue(found);
  await success(await addRef(f, pool, ref));
  expect(union.searchItems.mock.calls[0]?.[0]).toMatchObject({ keyword: title });
  expect(usedRaws()).toEqual([raw]);
  expect(await itemRow(h, f, pool, key)).toMatchObject({ raw_item_id: raw });
  expect((await snapshot(h, f.appId)).refs).toEqual([
    expect.objectContaining({ product_key: key, raw_item_id: raw, refreshed_at: f.clock.now() }),
  ]);
});

async function staleRow(f: Setup, key: string, raw: string) {
  const old = new Date(f.clock.now().getTime() - AGED);
  await seedRef(h, f, key, { raw_item_id: raw, raw_fetched_at: old, refreshed_at: old });
}

it('[AC-B1-05q#54] 两处都过期且搜不到任何结果 → 30143，不入库、不用过期原串', async () => {
  const f = await setup(h);
  const { pool, key, staleRaw, ref } = await agedRef(f);
  await staleRow(f, key, staleRaw);
  searchAnswers([[]]);
  const before = await snapshot(h, f.appId);
  await rejected(await addRef(f, pool, ref), 30143);
  expect(usedRaws()).not.toContain(staleRaw);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#55] 搜到的都不是这个键 → 30143，不入库', async () => {
  const f = await setup(h);
  const { pool, key, staleRaw, ref } = await agedRef(f);
  await staleRow(f, key, staleRaw);
  searchAnswers([[product(f, stableId()), product(f, stableId())]]);
  const before = await snapshot(h, f.appId);
  await rejected(await addRef(f, pool, ref), 30143);
  expect(usedRaws()).not.toContain(staleRaw);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#56] product_refs 的原串问到别的键 → 30143，不入库', async () => {
  const f = await setup(h);
  const { pool, stable, key, ref } = await agedRef(f);
  const raw = `freshA-${stable}`;
  await seedRef(h, f, key, { raw_item_id: raw });
  union.getItem.mockResolvedValue(product(f, stableId()));
  const before = await snapshot(h, f.appId);
  await rejected(await addRef(f, pool, ref), 30143);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#57] 没有 product_refs 行可回退 → 30143，不入库', async () => {
  const f = await setup(h);
  const { pool, staleRaw, ref } = await agedRef(f);
  searchAnswers([[]]);
  const before = await snapshot(h, f.appId);
  await rejected(await addRef(f, pool, ref), 30143);
  expect(usedRaws()).not.toContain(staleRaw);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#58] 重新解析时联盟答不了 → 50401 可重试，不是 30143，不写入', async () => {
  const f = await setup(h);
  const { pool, key, staleRaw, ref } = await agedRef(f);
  await staleRow(f, key, staleRaw);
  union.searchItems.mockRejectedValue(
    new UnionError('upstream_unavailable', 'synthetic outage', 'taobao'),
  );
  const before = await snapshot(h, f.appId);
  await rejected(await addRef(f, pool, ref, bounds(1)), 50401);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#59] 回退到新原串后联盟明确下架 → 30141，不入库', async () => {
  const f = await setup(h);
  const { pool, stable, key, ref } = await agedRef(f);
  await seedRef(h, f, key, { raw_item_id: `freshA-${stable}` });
  union.getItem.mockRejectedValue(new UnionError('item_unavailable', 'synthetic', 'taobao'));
  await rejected(await addRef(f, pool, ref), 30141);
  expect(await itemRow(h, f, pool, key)).toBeUndefined();
});
