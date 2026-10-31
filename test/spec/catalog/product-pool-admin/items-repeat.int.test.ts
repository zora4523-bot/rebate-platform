// BR-PROD-08 ③：重复入库走真实路由和真实表，不只测 ON CONFLICT（B1-05p 评审提醒）。
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  addLink,
  addRef,
  audit,
  bounds,
  hoursFromNow,
  instant,
  itemRow,
  linkOf,
  member,
  OFF_SHELF_REASON,
  PERMISSION,
  pick,
  product,
  rejected,
  rendezvous,
  seedItem,
  seedPool,
  setup,
  snapshot,
  stableId,
  stubProduct,
  success,
  union,
  useHarness,
  type Setup,
} from './kit.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';

const h = useHarness();

const offShelf = () => new UnionError('item_unavailable', 'synthetic off shelf', 'taobao');
const outage = () => new UnionError('upstream_unavailable', 'synthetic outage', 'taobao');

/** 池里已有这件商品（别的管理员早先加的），返回能重复提交的 item_ref。 */
async function existing(f: Setup, extra: Parameters<typeof seedItem>[4] = {}) {
  const pool = await seedPool(h, f);
  const creator = await member(h, f, [PERMISSION]);
  const stable = stableId();
  const item = product(f, stable);
  const row = await pick(f, item);
  await seedItem(h, f, pool, row.product_key, {
    created_by: creator.account.id,
    sort: 1,
    start_at: hoursFromNow(f, 1),
    end_at: hoursFromNow(f, 2),
    ...extra,
  });
  const seeded = (await itemRow(h, f, pool, row.product_key))!;
  union.getItem.mockClear();
  return { pool, creator, item, ref: row.item_ref, key: row.product_key, seeded };
}

it('[AC-B1-05q#41] 重复入库复核通过：覆盖三项、刷新价格、清原因，创建时间与创建人不变，仍一行', async () => {
  const f = await setup(h);
  const { pool, creator, item, ref, key, seeded } = await existing(f, {
    status: 'offline',
    invalid_reason: OFF_SHELF_REASON,
  });
  f.clock.advanceMs(60_000);
  const fresh = {
    ...item,
    price_fen: 5000n,
    coupon_fen: 500n,
    final_price_fen: 4500n,
    quoted_at: f.clock.now().toISOString(),
  };
  union.getItem.mockResolvedValue(fresh);
  const before = await snapshot(h, f.appId);
  const added = await success(await addRef(f, pool, ref, bounds(9, null, null)));
  expect(added).toMatchObject({
    product_key: key,
    status: 'online',
    invalid_reason: null,
    sort: 9,
    start_at: null,
    end_at: null,
    price_fen: 5000,
    coupon_fen: 500,
    final_price_fen: 4500,
    created_by: creator.account.id,
  });
  expect(instant(added.quoted_at)).toBe(fresh.quoted_at);
  expect(instant(added.created_at)).toBe(instant(seeded.created_at));
  expect(instant(added.updated_at)).toBe(f.clock.now().toISOString());
  expect(union.getItem).toHaveBeenCalledTimes(1);
  const state = await snapshot(h, f.appId);
  expect(state.items).toHaveLength(1);
  expect(state.items[0]).toMatchObject({
    created_at: seeded.created_at,
    created_by: creator.account.id,
    updated_at: f.clock.now(),
    start_at: null,
    end_at: null,
  });
  const entry = await audit(h, f, before, 'pool_item_add');
  expect(entry.before).toMatchObject({ product_key: key, sort: 1, status: 'offline' });
  expect(entry.after).toMatchObject({ product_key: key, sort: 9, status: 'online' });
});

it('[AC-B1-05q#42] 重复入库复核不通过：覆盖照样生效，200 带原因并下架，价格不动', async () => {
  const f = await setup(h);
  const { pool, ref, key, seeded } = await existing(f);
  f.clock.advanceMs(60_000);
  union.getItem.mockRejectedValue(offShelf());
  const end = hoursFromNow(f, 48);
  const before = await snapshot(h, f.appId);
  const added = await success(await addRef(f, pool, ref, bounds(7, null, end)));
  expect(added).toMatchObject({
    product_key: key,
    status: 'offline',
    invalid_reason: OFF_SHELF_REASON,
    sort: 7,
    start_at: null,
    price_fen: 8800,
    coupon_fen: 800,
    final_price_fen: 8000,
  });
  expect(instant(added.end_at)).toBe(end);
  expect(instant(added.quoted_at)).toBe(instant(seeded.quoted_at));
  const entry = await audit(h, f, before, 'pool_item_add');
  expect(entry.before).toMatchObject({ sort: 1, status: 'online' });
  expect(entry.after).toMatchObject({ sort: 7, status: 'offline' });
});

it('[AC-B1-05q#43] 已下架的条目复核仍不通过：保持 offline，原因是这一次的', async () => {
  const f = await setup(h);
  const { pool, ref } = await existing(f, { status: 'offline', invalid_reason: '上一次的原因' });
  f.clock.advanceMs(60_000);
  union.getItem.mockRejectedValue(offShelf());
  expect(await success(await addRef(f, pool, ref, bounds(4)))).toMatchObject({
    status: 'offline',
    invalid_reason: OFF_SHELF_REASON,
    sort: 4,
  });
});

it('[AC-B1-05q#44] 复核答不了 → 50401，覆盖也不生效', async () => {
  const f = await setup(h);
  const { pool, ref } = await existing(f);
  f.clock.advanceMs(60_000);
  union.getItem.mockRejectedValue(outage());
  const before = await snapshot(h, f.appId);
  await rejected(await addRef(f, pool, ref, bounds(7)), 50401);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it('[AC-B1-05q#45] 重复入库下架时，同 key 在别的池里的条目一并下架（BR-PROD-05 ①）', async () => {
  const f = await setup(h);
  const { pool, ref, key } = await existing(f);
  const elsewhere = await seedPool(h, f);
  await seedItem(h, f, elsewhere, key, { sort: 5 });
  f.clock.advanceMs(60_000);
  union.getItem.mockRejectedValue(offShelf());
  await success(await addRef(f, pool, ref, bounds(7)));
  expect(await itemRow(h, f, elsewhere, key)).toMatchObject({
    status: 'offline',
    invalid_reason: OFF_SHELF_REASON,
    sort: 5,
  });
});

it('[AC-B1-05q#46] 链接重复入库命中同一行，同样跑复核', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const stable = stableId();
  const item = product(f, stable);
  await seedItem(h, f, pool, `tb:${stable}`, { sort: 1 });
  f.clock.advanceMs(60_000);
  stubProduct({ ...item, final_price_fen: 2000n, quoted_at: f.clock.now().toISOString() });
  expect(await success(await addLink(f, pool, linkOf(item.item_id!), bounds(2)))).toMatchObject({
    product_key: `tb:${stable}`,
    sort: 2,
    final_price_fen: 2000,
  });
  expect((await snapshot(h, f.appId)).items).toHaveLength(1);
});

it('[AC-B1-05q#47] 同一商品并发入库由唯一键裁决：都不报错，只留一行，新建和覆盖各一条审计', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const stable = stableId();
  const item = product(f, stable);
  const together = rendezvous(2);
  union.resolveLink.mockResolvedValue({ item: { platform: 'taobao', item_id: item.item_id! } });
  union.getItem.mockImplementation(async () => {
    await together();
    return item;
  });
  const attempts = await Promise.all(
    [1, 2].map((sort) => addLink(f, pool, linkOf(item.item_id!), bounds(sort))),
  );
  for (const sent of attempts) await success(sent);
  const state = await snapshot(h, f.appId);
  expect(state.items).toHaveLength(1);
  expect([1, 2]).toContain(state.items[0]!.sort);
  expect(state.audits.map((a) => a.action)).toEqual(['pool_item_add', 'pool_item_add']);
  expect(state.audits.map((a) => a.before === null).sort()).toEqual([false, true]);
});

it('[AC-B1-05q#48] 任意提交序列：最后一次的三项生效，始终一行，created_at 和创建人不变', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const submission = fc.record({
    sort: fc.nat({ max: 1000 }),
    start: fc.option(fc.integer({ min: -48, max: 48 }), { nil: null }),
    span: fc.option(fc.integer({ min: 1, max: 48 }), { nil: null }),
  });
  await fc.assert(
    fc.asyncProperty(fc.array(submission, { minLength: 2, maxLength: 4 }), async (list) => {
      const stable = stableId();
      const item = product(f, stable);
      stubProduct(item);
      const key = `tb:${stable}`;
      let created: Date | undefined;
      for (const { sort, start, span } of list) {
        const startAt = start === null ? null : hoursFromNow(f, start);
        const endAt = span === null ? null : hoursFromNow(f, (start ?? 0) + span);
        await success(await addLink(f, pool, linkOf(item.item_id!), bounds(sort, startAt, endAt)));
        const row = (await itemRow(h, f, pool, key))!;
        created ??= row.created_at;
        expect(row).toMatchObject({ sort, created_at: created, created_by: f.actor.id });
        expect(instant(row.start_at)).toBe(startAt);
        expect(instant(row.end_at)).toBe(endAt);
        f.clock.advanceMs(1000);
      }
      const rows = (await snapshot(h, f.appId)).items.filter((row) => row.product_key === key);
      expect(rows).toHaveLength(1);
    }),
    { numRuns: 8, endOnFailure: true },
  );
});
