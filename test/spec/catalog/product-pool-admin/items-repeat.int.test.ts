// BR-PROD-08 ③：重复入库走真实路由和真实表，不只测 ON CONFLICT（B1-05p 评审提醒）。
import { propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  addLink,
  addRef,
  age,
  audit,
  bounds,
  foreignItem,
  hoursFromNow,
  instant,
  itemRow,
  linkOf,
  member,
  OFF_SHELF_REASON,
  PERMISSION,
  pick,
  product,
  RAW_MAX_AGE_MS,
  rejected,
  rendezvous,
  searchAnswers,
  seedItem,
  seedPool,
  seedRef,
  send,
  setup,
  snapshot,
  stableId,
  stubProduct,
  success,
  union,
  useHarness,
  type Sent,
  type Setup,
  type Snapshot,
} from './kit.ts';
import {
  DemoUnionError,
  UnionError,
  type UnionItemDetail,
} from '../../../../apps/api/src/modules/union/index.ts';

const h = useHarness();

const offShelf = () => new UnionError('item_unavailable', 'synthetic off shelf', 'taobao');
const outage = () => new UnionError('upstream_unavailable', 'synthetic outage', 'taobao');
const refused = () => new UnionError('upstream_rejected', 'synthetic refusal', 'taobao');

const AGED = RAW_MAX_AGE_MS + 1000;
/** 只钉非空，不钉文案。 */
const SOME_REASON = expect.stringMatching(/\S/);

/** 联盟答了，但标记价格异常；价格与池里不同，且 price - coupon = final。 */
function anomalous(f: Pick<Setup, 'clock'>, item: UnionItemDetail): UnionItemDetail {
  return {
    ...item,
    price_fen: 5000n,
    coupon_fen: 500n,
    final_price_fen: 4500n,
    quoted_at: f.clock.now().toISOString(),
    price_status: 'anomaly',
    price_anomaly_reason: 'unknown_promo',
  };
}

/** 链接和口令先认出商品、派生出 key，详情阶段才知道下架：key 已知，不能一律当拒绝。 */
interface OffShelfInput {
  name: string;
  text: (item: UnionItemDetail) => string;
  error: () => Error;
}
const OFF_SHELF_INPUTS: readonly OffShelfInput[] = [
  { name: '链接且联盟明确下架', text: (item) => linkOf(item.item_id!), error: offShelf },
  {
    name: '链接且演示下架场景',
    text: (item) => linkOf(item.item_id!),
    error: () => new DemoUnionError('demo_delisted', 'synthetic off shelf', 'taobao'),
  },
  { name: '口令且联盟明确下架', text: () => '￥AbCdEf12￥', error: offShelf },
];

/**
 * 每个样本是真实路由上 2～4 次入库，次数按 PROP_RUNS 的 1/1000 折算，下限 8（PROP_RUNS 10 000 → 10，
 * 100 000 → 100），种子就是 PROP_SEED。
 */
const SEQUENCE_RUNS = Math.max(8, Math.floor(propRuns() / 1000));
/** 60 秒固定开销，另加每个样本 1 秒。 */
const SEQUENCE_TIMEOUT_MS = 60_000 + SEQUENCE_RUNS * 1_000;
/** 联盟配额桶按注入的时钟回填：每次提交后拨够，样本再多也不会被本地配额打成 50401。 */
const SEQUENCE_STEP_MS = 5_000;

interface Submission {
  sort: number;
  start: number | null;
  span: number | null;
}
const submissionArb: fc.Arbitrary<Submission> = fc.record({
  sort: fc.nat({ max: 1000 }),
  start: fc.option(fc.integer({ min: -48, max: 48 }), { nil: null }),
  span: fc.option(fc.integer({ min: 1, max: 48 }), { nil: null }),
});

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

it.each(['item_ref', 'link_text'] as const)(
  '[AC-B1-05q#45] %s 重复入库下架时，本 App 别的池里同 key 的条目一并下架，别的 App 的不动（BR-PROD-05 ①）',
  async (source) => {
    const f = await setup(h);
    const { pool, ref, item, key } = await existing(f);
    const elsewhere = await seedPool(h, f);
    await seedItem(h, f, elsewhere, key, { sort: 5 });
    const foreign = await foreignItem(h, f, key);
    f.clock.advanceMs(60_000);
    stubProduct(item);
    union.getItem.mockRejectedValue(offShelf());
    const sent =
      source === 'item_ref'
        ? await addRef(f, pool, ref, bounds(7))
        : await addLink(f, pool, linkOf(item.item_id!), bounds(7));
    await success(sent);
    expect(await itemRow(h, f, elsewhere, key)).toMatchObject({
      status: 'offline',
      invalid_reason: OFF_SHELF_REASON,
      sort: 5,
    });
    expect(await itemRow(h, foreign.app, foreign.pool, key)).toEqual(foreign.row);
  },
);

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

it.each(OFF_SHELF_INPUTS)(
  '[AC-B1-05q#107] $name时重复入库：不报 30141，覆盖照样生效，200 带原因并下架，价格、创建人不动',
  async ({ text, error }) => {
    const f = await setup(h);
    const { pool, creator, item, key, seeded } = await existing(f);
    f.clock.advanceMs(60_000);
    stubProduct(item);
    union.getItem.mockRejectedValue(error());
    const end = hoursFromNow(f, 48);
    const before = await snapshot(h, f.appId);
    const added = await success(await addLink(f, pool, text(item), bounds(7, null, end)));
    expect(added).toMatchObject({
      product_key: key,
      status: 'offline',
      invalid_reason: OFF_SHELF_REASON,
      sort: 7,
      start_at: null,
      price_fen: 8800,
      coupon_fen: 800,
      final_price_fen: 8000,
      created_by: creator.account.id,
    });
    expect(instant(added.end_at)).toBe(end);
    expect(instant(added.quoted_at)).toBe(instant(seeded.quoted_at));
    expect(instant(added.created_at)).toBe(instant(seeded.created_at));
    expect(await itemRow(h, f, pool, key)).toMatchObject({
      status: 'offline',
      invalid_reason: OFF_SHELF_REASON,
      sort: 7,
      start_at: null,
      created_by: creator.account.id,
    });
    const entry = await audit(h, f, before, 'pool_item_add');
    expect(entry.before).toMatchObject({ sort: 1, status: 'online' });
    expect(entry.after).toMatchObject({ sort: 7, status: 'offline' });
  },
);

it.each(OFF_SHELF_INPUTS)(
  '[AC-B1-05q#108] $name时新 key：30141 不入库，本 App 别的池里同 key 的条目下架，别的 App 的不动',
  async ({ text, error }) => {
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const elsewhere = await seedPool(h, f);
    const stable = stableId();
    const key = `tb:${stable}`;
    const item = product(f, stable);
    await seedItem(h, f, elsewhere, key, { sort: 5 });
    const foreign = await foreignItem(h, f, key);
    stubProduct(item);
    union.getItem.mockRejectedValue(error());
    await rejected(await addLink(f, pool, text(item)), 30141);
    expect(await itemRow(h, f, pool, key)).toBeUndefined();
    expect(await itemRow(h, f, elsewhere, key)).toMatchObject({
      status: 'offline',
      invalid_reason: OFF_SHELF_REASON,
      sort: 5,
    });
    expect(await itemRow(h, foreign.app, foreign.pool, key)).toEqual(foreign.row);
  },
);

it('[AC-B1-05q#109] 链接重复入库复核通过：已下架的条目回到 online，清原因、刷新价格，创建时间与别人的创建人不变', async () => {
  const f = await setup(h);
  const { pool, creator, item, key, seeded } = await existing(f, {
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
  stubProduct(fresh);
  const before = await snapshot(h, f.appId);
  const added = await success(await addLink(f, pool, linkOf(item.item_id!), bounds(9)));
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
  expect(await itemRow(h, f, pool, key)).toMatchObject({
    status: 'online',
    invalid_reason: null,
    created_at: seeded.created_at,
    created_by: creator.account.id,
    updated_at: f.clock.now(),
  });
  const entry = await audit(h, f, before, 'pool_item_add');
  expect(entry.before).toMatchObject({ product_key: key, sort: 1, status: 'offline' });
  expect(entry.after).toMatchObject({ product_key: key, sort: 9, status: 'online' });
});

it('[AC-B1-05q#110] 链接重复入库时复核答不了 → 50401，覆盖也不生效', async () => {
  const f = await setup(h);
  const { pool, item } = await existing(f);
  f.clock.advanceMs(60_000);
  stubProduct(item);
  union.getItem.mockRejectedValue(outage());
  const before = await snapshot(h, f.appId);
  await rejected(await addLink(f, pool, linkOf(item.item_id!), bounds(7)), 50401);
  expect(await snapshot(h, f.appId)).toEqual(before);
});

/** 本 App 别的池里也有这个 key，返回改动前的行：这些情形不是联盟明确下架，不能牵连它。 */
async function sibling(f: Setup, key: string) {
  const pool = await seedPool(h, f);
  await seedItem(h, f, pool, key, { sort: 5 });
  return { pool, row: await itemRow(h, f, pool, key) };
}

/** 复核不通过的重复入库：三项覆盖生效，这一行 offline 带原因，价格与创建信息不动，别的池不动。 */
async function expectHeldOffline(
  f: Setup,
  held: Awaited<ReturnType<typeof existing>>,
  other: Awaited<ReturnType<typeof sibling>>,
  before: Snapshot,
  sent: Sent,
  end: string,
) {
  const { pool, key, creator, seeded } = held;
  const added = await success(sent);
  expect(added).toMatchObject({
    product_key: key,
    status: 'offline',
    invalid_reason: SOME_REASON,
    sort: 7,
    start_at: null,
    price_fen: 8800,
    coupon_fen: 800,
    final_price_fen: 8000,
    created_by: creator.account.id,
  });
  expect(instant(added.end_at)).toBe(end);
  expect(instant(added.quoted_at)).toBe(instant(seeded.quoted_at));
  expect(instant(added.created_at)).toBe(instant(seeded.created_at));
  const row = await itemRow(h, f, pool, key);
  expect(row).toMatchObject({
    status: 'offline',
    invalid_reason: SOME_REASON,
    sort: 7,
    start_at: null,
    price_fen: seeded.price_fen,
    coupon_fen: seeded.coupon_fen,
    final_price_fen: seeded.final_price_fen,
    quoted_at: seeded.quoted_at,
    created_at: seeded.created_at,
    created_by: creator.account.id,
  });
  expect(instant(row!.end_at)).toBe(end);
  const entry = await audit(h, f, before, 'pool_item_add');
  expect(entry.before).toMatchObject({ product_key: key, sort: 1, status: 'online' });
  expect(entry.after).toMatchObject({ product_key: key, sort: 7, status: 'offline' });
  expect(await itemRow(h, f, other.pool, key)).toEqual(other.row);
}

it.each([
  { name: '标题搜索第 1 页为空', page: (): UnionItemDetail[] => [] },
  {
    name: '标题搜索第 1 页没有同键',
    page: (f: Setup): UnionItemDetail[] => [product(f, stableId()), product(f, stableId())],
  },
])(
  '[AC-B1-05q#112] 过期 item_ref 重复入库，product_refs 也过期，$name：200，覆盖生效，这一行 offline 带原因，价格、创建信息、别的池不动，不用过期原串',
  async ({ page }) => {
    const f = await setup(h);
    const held = await existing(f);
    const other = await sibling(f, held.key);
    await age(f, AGED);
    const old = new Date(f.clock.now().getTime() - AGED);
    await seedRef(h, f, held.key, {
      raw_item_id: held.item.item_id!,
      raw_fetched_at: old,
      refreshed_at: old,
    });
    searchAnswers([page(f)]);
    union.searchItems.mockClear();
    union.getItem.mockResolvedValue(held.item);
    const end = hoursFromNow(f, 48);
    const before = await snapshot(h, f.appId);
    const sent = await addRef(f, held.pool, held.ref, bounds(7, null, end));
    await expectHeldOffline(f, held, other, before, sent, end);
    expect(union.searchItems).toHaveBeenCalled();
    expect(union.getItem.mock.calls.map(([ref]) => ref.item_id)).not.toContain(held.item.item_id);
  },
);

it('[AC-B1-05q#113] 新鲜 item_ref 重复入库而联盟拒绝原串（upstream_rejected）：200，覆盖生效，这一行 offline 带原因，价格、创建信息、别的池不动', async () => {
  const f = await setup(h);
  const held = await existing(f);
  const other = await sibling(f, held.key);
  f.clock.advanceMs(60_000);
  union.getItem.mockRejectedValue(refused());
  const end = hoursFromNow(f, 48);
  const before = await snapshot(h, f.appId);
  const sent = await addRef(f, held.pool, held.ref, bounds(7, null, end));
  await expectHeldOffline(f, held, other, before, sent, end);
});

it('[AC-B1-05q#114] 链接重复入库，解析成功而联盟拒绝原串（upstream_rejected）：200，覆盖生效，这一行 offline 带原因，价格、创建信息、别的池不动', async () => {
  const f = await setup(h);
  const held = await existing(f);
  const other = await sibling(f, held.key);
  f.clock.advanceMs(60_000);
  stubProduct(held.item);
  union.getItem.mockRejectedValue(refused());
  const end = hoursFromNow(f, 48);
  const before = await snapshot(h, f.appId);
  const sent = await addLink(f, held.pool, linkOf(held.item.item_id!), bounds(7, null, end));
  await expectHeldOffline(f, held, other, before, sent, end);
});

it.each(['item_ref', 'link_text'] as const)(
  '[AC-B1-05q#115] %s 重复入库时联盟标记价格异常：200，覆盖生效，这一行 offline 带原因，价格、创建信息、别的池不动',
  async (source) => {
    const f = await setup(h);
    const held = await existing(f);
    const other = await sibling(f, held.key);
    f.clock.advanceMs(60_000);
    stubProduct(anomalous(f, held.item));
    const end = hoursFromNow(f, 48);
    const before = await snapshot(h, f.appId);
    const at = bounds(7, null, end);
    const sent =
      source === 'item_ref'
        ? await addRef(f, held.pool, held.ref, at)
        : await addLink(f, held.pool, linkOf(held.item.item_id!), at);
    await expectHeldOffline(f, held, other, before, sent, end);
  },
);

it('[AC-B1-05q#116] 重新上架时联盟标记价格异常：200，保持 offline 带原因，价格不动', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const stable = stableId();
  const key = `tb:${stable}`;
  const item = product(f, stable);
  // 手动下架的行没有原因：响应里的原因只能来自这一次复核。
  await seedItem(h, f, pool, key, { status: 'offline', invalid_reason: null });
  await seedRef(h, f, key, { raw_item_id: item.item_id! });
  const seeded = (await itemRow(h, f, pool, key))!;
  f.clock.advanceMs(1000);
  union.getItem.mockResolvedValue(anomalous(f, item));
  const before = await snapshot(h, f.appId);
  const updated = await success(await send(f, 'updateItem', { pool, key }, { status: 'online' }));
  expect(updated).toMatchObject({
    product_key: key,
    status: 'offline',
    invalid_reason: SOME_REASON,
    price_fen: 8800,
    coupon_fen: 800,
    final_price_fen: 8000,
  });
  expect(instant(updated.quoted_at)).toBe(instant(seeded.quoted_at));
  expect(await itemRow(h, f, pool, key)).toMatchObject({
    status: 'offline',
    invalid_reason: SOME_REASON,
    price_fen: seeded.price_fen,
    coupon_fen: seeded.coupon_fen,
    final_price_fen: seeded.final_price_fen,
    quoted_at: seeded.quoted_at,
  });
  await audit(h, f, before, 'pool_item_update');
});

it.each(['item_ref', 'link_text'] as const)(
  '[AC-B1-05q#117] %s 新 key 且联盟标记价格异常 → 50401，什么都不写',
  async (source) => {
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const item = product(f, stableId());
    const row = await pick(f, item);
    const other = await sibling(f, row.product_key);
    stubProduct(anomalous(f, item));
    const before = await snapshot(h, f.appId);
    const sent =
      source === 'item_ref'
        ? await addRef(f, pool, row.item_ref)
        : await addLink(f, pool, linkOf(item.item_id!));
    await rejected(sent, 50401);
    expect(await itemRow(h, f, pool, row.product_key)).toBeUndefined();
    expect(await itemRow(h, f, other.pool, row.product_key)).toEqual(other.row);
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it('[AC-B1-05q#47] 同一商品并发入库由唯一键裁决：都不报错，只留一行，新建和覆盖各一条审计', async () => {
  const f = await setup(h);
  const pool = await seedPool(h, f);
  const before = await snapshot(h, f.appId);
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
  const seen = new Set(before.audits.map((a) => a.id));
  const added = state.audits.filter((a) => !seen.has(a.id));
  expect(added.map((a) => a.action)).toEqual(['pool_item_add', 'pool_item_add']);
  expect(added.map((a) => a.before === null).sort()).toEqual([false, true]);
});

/** 一个提交序列；返回违反的不变量（空表示成立），断言留在属性外面。 */
async function resubmit(
  f: Setup,
  pool: string,
  list: readonly Submission[],
): Promise<readonly string[]> {
  const violations: string[] = [];
  const check = (ok: boolean, what: string): void => {
    if (!ok) violations.push(what);
  };
  const stable = stableId();
  const item = product(f, stable);
  stubProduct(item);
  const key = `tb:${stable}`;
  const created = f.clock.now().getTime();
  for (const { sort, start, span } of list) {
    const startAt = start === null ? null : hoursFromNow(f, start);
    const endAt = span === null ? null : hoursFromNow(f, (start ?? 0) + span);
    const sent = await addLink(f, pool, linkOf(item.item_id!), bounds(sort, startAt, endAt));
    check(sent.response.statusCode === 200, `add answered ${String(sent.response.statusCode)}`);
    const row = await itemRow(h, f, pool, key);
    if (row === undefined) return [...violations, 'row missing'];
    check(row.sort === sort, `sort ${String(row.sort)} ≠ ${String(sort)}`);
    check(instant(row.start_at) === startAt, `start_at ≠ ${String(startAt)}`);
    check(instant(row.end_at) === endAt, `end_at ≠ ${String(endAt)}`);
    check(row.created_at.getTime() === created, `created_at moved to ${String(row.created_at)}`);
    check(row.created_by === f.actor.id, `created_by moved to ${row.created_by}`);
    f.clock.advanceMs(SEQUENCE_STEP_MS);
  }
  const rows = (await snapshot(h, f.appId)).items.filter((row) => row.product_key === key);
  check(rows.length === 1, `${String(rows.length)} rows for one key`);
  return violations;
}

it(
  '[AC-B1-05q#48] 任意提交序列：最后一次的三项生效，始终一行，created_at 和创建人不变',
  async () => {
    const f = await setup(h);
    const pool = await seedPool(h, f);
    const failures = new Map<string, readonly string[]>();
    const details = await fc.check(
      fc.asyncProperty(fc.array(submissionArb, { minLength: 2, maxLength: 4 }), async (list) => {
        const violations = await resubmit(f, pool, list);
        if (violations.length > 0) failures.set(JSON.stringify(list), violations);
        return violations.length === 0;
      }),
      { numRuns: SEQUENCE_RUNS, seed: propSeed(), endOnFailure: true },
    );
    const counterexample = details.counterexample?.[0];
    const why =
      counterexample === undefined ? [] : (failures.get(JSON.stringify(counterexample)) ?? []);
    expect(details.failed, `${fc.defaultReportMessage(details) ?? ''}\n${why.join('\n')}`).toBe(
      false,
    );
  },
  SEQUENCE_TIMEOUT_MS,
);
