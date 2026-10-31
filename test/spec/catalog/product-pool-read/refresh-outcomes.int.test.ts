// B1-05r: what one refresh round does to the rows (BR-PRICE-11, BR-PROD-05 结果分类, BR-PROD-07 主动失效,
// F-ADM-10). The union is asked once per (app_id, product_key) on the quota purpose pool_refresh; the
// raw ID comes by the BR-PROD-05 order, where pool_items.raw_item_id counts for nothing. Success writes
// the five price fields to every online row of the key and leaves its raw ID; off shelf takes every
// row of the key offline; a dead reference, a temporary failure and an anomalous price leave the rows
// as they are, and age then takes them off the shelves by itself.
import { expect, it } from 'vitest';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  DemoUnionError,
  UnionError,
  type UnionItemDetail,
} from '../../../../apps/api/src/modules/union/index.ts';
import { itemRow, OFF_SHELF_REASON, refreshCase, secondsAgo, seedItem, TIMEOUT } from './kit.ts';

/** Past one round and past the raw ID's 1800 seconds, so a row is due in every design of the seed. */
const DUE_SEC = 4000;
const PURPOSE = 'pool_refresh';

interface PlatformCase {
  readonly platform: 'jd' | 'pdd';
  readonly key: string;
  readonly raw: string;
  readonly ids: Partial<UnionItemDetail>;
}
const OTHER_PLATFORMS: readonly PlatformCase[] = [
  {
    platform: 'pdd',
    key: 'pdd:g4411',
    raw: 'sign-4411',
    ids: { goods_id: 'g4411', goods_sign: 'sign-4411' },
  },
  {
    platform: 'jd',
    key: 'jd:i_4412',
    raw: 'synthetic_4412',
    ids: { itemId: 'synthetic_4412', skuId: 'sku4412' },
  },
];

interface AnswerCase {
  readonly label: string;
  readonly extra: Partial<UnionItemDetail>;
}
const ANOMALIES: readonly AnswerCase[] = [
  {
    label: '联盟标记价格异常',
    extra: {
      price_fen: 5000n,
      coupon_fen: 500n,
      final_price_fen: 4500n,
      commission_rate_bp: 900n,
      price_status: 'anomaly',
      price_anomaly_reason: 'unknown_promo',
    },
  },
  {
    label: '三个价格字段对不上',
    extra: { price_fen: 5000n, coupon_fen: 500n, final_price_fen: 4000n, commission_rate_bp: 900n },
  },
];
const INVALIDATIONS: readonly (AnswerCase & { readonly stored: Record<string, unknown> })[] = [
  { label: '佣金为 0', extra: { commission_rate_bp: 0n }, stored: { commission_rate_bp: 0 } },
  {
    label: '券失效',
    extra: { price_fen: 6000n, coupon_fen: 0n, final_price_fen: 6000n },
    stored: { coupon_fen: 0n, final_price_fen: 6000n },
  },
];

const REF_EXPIRED = [
  {
    label: 'upstream_rejected',
    error: new UnionError('upstream_rejected', 'synthetic refusal', 'taobao'),
  },
  { label: 'invalid_dto', error: new UnionError('invalid_dto', 'synthetic invalid', 'taobao') },
  {
    label: 'link_unrecognized',
    error: new UnionError('link_unrecognized', 'synthetic unknown', 'taobao'),
  },
];
const TEMPORARY = [
  {
    label: 'UnionError upstream_unavailable',
    error: new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao'),
  },
  {
    label: 'UnionError rate_limited',
    error: new UnionError('rate_limited', 'synthetic rate limited', 'taobao'),
  },
  {
    label: 'GovernanceError timeout',
    error: new GovernanceError('timeout', 'union:taobao:pool_refresh', 'synthetic slow'),
  },
  {
    label: 'GovernanceError circuit_open',
    error: new GovernanceError('circuit_open', 'union:taobao:pool_refresh', 'synthetic open'),
  },
  {
    label: 'GovernanceError quota_exceeded',
    error: new GovernanceError('quota_exceeded', 'union:taobao:pool_refresh', 'synthetic quota'),
  },
];

it(
  '[BR-PRICE-11] 成功：同一个 key 在几个池里只问一次，全部 online 行写入新价、新佣金率和联盟给的 quoted_at，sort 不动，下线的行不动',
  async () => {
    await refreshCase(async (f) => {
      const stable = f.stableOf();
      const [first, second, parked] = [await f.pool(), await f.pool(), await f.pool()];
      const aged = secondsAgo(f.clock, DUE_SEC);
      await f.item(first, stable, { quoted_at: aged, commission_rate_bp: null });
      await f.item(second, stable, { quoted_at: aged, sort: 7 });
      await f.item(parked, stable, {
        quoted_at: aged,
        status: 'offline',
        invalid_reason: OFF_SHELF_REASON,
      });
      await f.ref(stable);
      const received = secondsAgo(f.clock, 5);
      f.unionAnswers(stable, { quoted_at: received.toISOString() });
      const before = await f.row(parked, stable);

      await f.round();

      expect(f.asked).toEqual([`rawRef-${stable}`]);
      for (const pool of [first, second]) {
        expect(await f.row(pool, stable)).toMatchObject({
          price_fen: 6000n,
          coupon_fen: 1000n,
          final_price_fen: 5000n,
          commission_rate_bp: 1500,
          quoted_at: received,
          status: 'online',
          invalid_reason: null,
          raw_item_id: `rawPool-${stable}`,
        });
      }
      expect((await f.row(second, stable)).sort).toBe(7);
      expect(await f.row(parked, stable)).toEqual(before);
      expect(f.dropped).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11][F-ADM-10] 配额走 pool_refresh：详情和重解析的联盟调用都带这个用途和本 App',
  async () => {
    await refreshCase(async (f) => {
      const withRef = f.stableOf();
      const withoutRef = f.stableOf();
      const pool = await f.pool();
      await f.item(pool, withRef, { quoted_at: secondsAgo(f.clock, DUE_SEC) });
      await f.item(pool, withoutRef, { quoted_at: secondsAgo(f.clock, DUE_SEC) });
      await f.ref(withRef);
      f.unionAnswers(withRef);
      f.unionAnswers(withoutRef);

      await f.round();

      expect(f.searchItems).toHaveBeenCalled();
      expect(f.getItem).toHaveBeenCalledTimes(2);
      expect(f.contexts.length).toBeGreaterThan(2);
      for (const context of f.contexts) {
        expect(context).toEqual({ appId: f.owner.appId, purpose: PURPOSE });
      }
    });
  },
  TIMEOUT,
);

it(
  '[BR-PROD-05] 原串走 product_refs：不用 pool_items.raw_item_id',
  async () => {
    await refreshCase(async (f) => {
      const stable = f.stableOf();
      await f.item(await f.pool(), stable, { quoted_at: secondsAgo(f.clock, DUE_SEC) });
      await f.ref(stable);
      f.unionAnswers(stable);

      await f.round();

      expect(f.asked).toEqual([`rawRef-${stable}`]);
      expect(f.searchItems).not.toHaveBeenCalled();
    });
  },
  TIMEOUT,
);

it(
  '[BR-PROD-05] product_refs 过期有 canonical_url → 按链接重解析，用解析出的原串问详情',
  async () => {
    await refreshCase(async (f) => {
      const stable = f.stableOf();
      const raw = `rawNew-${stable}`;
      const pool = await f.pool();
      await f.item(pool, stable, { quoted_at: secondsAgo(f.clock, DUE_SEC) });
      await f.ref(stable, f.owner, {
        canonical_url: `https://demo.invalid/taobao/${stable}`,
        raw_fetched_at: secondsAgo(f.clock, DUE_SEC),
        refreshed_at: secondsAgo(f.clock, DUE_SEC),
      });
      f.resolveLink.mockResolvedValue({ item: { platform: 'taobao', item_id: raw } });
      f.answers.set(raw, () => f.answer(stable, { item_id: raw }));

      await f.round();

      expect(f.asked).toEqual([raw]);
      expect(await f.row(pool, stable)).toMatchObject({ final_price_fen: 5000n });
    });
  },
  TIMEOUT,
);

it(
  '[BR-PROD-05] 没有 product_refs → 按池里的标题重解析，不把 pool_items.raw_item_id 拿去问详情',
  async () => {
    await refreshCase(async (f) => {
      const stable = f.stableOf();
      const pool = await f.pool();
      await f.item(pool, stable, { quoted_at: secondsAgo(f.clock, DUE_SEC) });
      f.unionAnswers(stable);
      const { title } = await f.row(pool, stable);

      await f.round();

      expect(f.searchItems.mock.calls[0]?.[0]).toMatchObject({ keyword: title });
      expect(f.asked).toEqual([`rawRef-${stable}`]);
      expect(await f.row(pool, stable)).toMatchObject({ final_price_fen: 5000n });
    });
  },
  TIMEOUT,
);

it.each(OTHER_PLATFORMS)(
  '[BR-PROD-05] $platform：原串放进该平台的字段，答复派生回同一个 key 才写入',
  async ({ platform, key, raw, ids }) => {
    await refreshCase(async (f) => {
      const pool = await f.pool();
      await seedItem(f.db, f.owner, f.clock, pool, key, {
        platform,
        quoted_at: secondsAgo(f.clock, DUE_SEC),
      });
      await f.ref('unused', f.owner, { product_key: key, platform, raw_item_id: raw });
      f.answers.set(raw, () => f.answer('unused', { platform, item_id: null, ...ids }));

      await f.round();

      expect(f.asked).toEqual([raw]);
      expect(await itemRow(f.db, f.owner.appId, pool, key)).toMatchObject({
        final_price_fen: 5000n,
        commission_rate_bp: 1500,
      });
    });
  },
  TIMEOUT,
);

it.each([
  {
    label: '联盟明确下架',
    error: new UnionError('item_unavailable', 'synthetic off shelf', 'taobao'),
  },
  {
    label: '演示下架',
    error: new DemoUnionError('demo_delisted', 'synthetic off shelf', 'taobao'),
  },
])(
  '[BR-PROD-05] ① $label：本 App 这个 key 的全部行下线，原因「联盟返回下架」，价格不动，删详情缓存；别的 key、别的 App 不受影响',
  async ({ error }) => {
    await refreshCase(async (f) => {
      const stable = f.stableOf();
      const healthy = f.stableOf();
      const other = await f.other();
      const [first, second, foreign] = [await f.pool(), await f.pool(), await f.pool(other)];
      const aged = secondsAgo(f.clock, DUE_SEC);
      await f.item(first, stable, { quoted_at: aged });
      await f.item(second, stable, { quoted_at: aged });
      await f.item(first, healthy, { quoted_at: aged });
      await f.item(foreign, stable, { quoted_at: aged }, other);
      await f.ref(stable);
      await f.ref(healthy);
      await f.ref(stable, other, { raw_item_id: `rawOther-${stable}` });
      f.unionFails(stable, error);
      f.unionAnswers(healthy);
      f.answers.set(`rawOther-${stable}`, () => f.answer(stable));

      await f.round();

      for (const pool of [first, second]) {
        expect(await f.row(pool, stable)).toMatchObject({
          status: 'offline',
          invalid_reason: OFF_SHELF_REASON,
          price_fen: 8800n,
          quoted_at: aged,
        });
      }
      expect(await f.row(first, healthy)).toMatchObject({ status: 'online', price_fen: 6000n });
      expect(await f.row(foreign, stable, other)).toMatchObject({
        status: 'online',
        invalid_reason: null,
        price_fen: 6000n,
      });
      expect(f.dropped).toEqual([[f.owner.appId, `tb:${stable}`]]);
    });
  },
  TIMEOUT,
);

it(
  '[BR-PROD-05] ① 重解析时联盟明确下架也算下架',
  async () => {
    await refreshCase(async (f) => {
      const stable = f.stableOf();
      const pool = await f.pool();
      await f.item(pool, stable, { quoted_at: secondsAgo(f.clock, DUE_SEC) });
      f.searchItems.mockRejectedValue(
        new UnionError('item_unavailable', 'synthetic off shelf', 'taobao'),
      );

      await f.round();

      expect(await f.row(pool, stable)).toMatchObject({
        status: 'offline',
        invalid_reason: OFF_SHELF_REASON,
      });
      expect(f.dropped).toEqual([[f.owner.appId, `tb:${stable}`]]);
    });
  },
  TIMEOUT,
);

it.each(REF_EXPIRED)(
  '[BR-PROD-05] ② 引用失效（$label）：不下架、不动价格，不删详情缓存',
  async ({ error }) => {
    await refreshCase(async (f) => {
      const stable = f.stableOf();
      const pool = await f.pool();
      await f.item(pool, stable, { quoted_at: secondsAgo(f.clock, DUE_SEC) });
      await f.ref(stable);
      f.unionFails(stable, error);
      const before = await f.row(pool, stable);

      await f.round();

      expect(f.asked).toEqual([`rawRef-${stable}`]);
      expect(await f.row(pool, stable)).toEqual(before);
      expect(f.dropped).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[BR-PROD-05] ② 重解析找不到同键商品：不下架、不动价格',
  async () => {
    await refreshCase(async (f) => {
      const stable = f.stableOf();
      const pool = await f.pool();
      await f.item(pool, stable, { quoted_at: secondsAgo(f.clock, DUE_SEC) });
      const before = await f.row(pool, stable);

      await f.round();

      expect(f.searchItems).toHaveBeenCalled();
      expect(f.asked).toEqual([]);
      expect(await f.row(pool, stable)).toEqual(before);
      expect(f.dropped).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[BR-PROD-05] ② 联盟答复派生出别的 key：不下架、不动价格',
  async () => {
    await refreshCase(async (f) => {
      const stable = f.stableOf();
      const pool = await f.pool();
      await f.item(pool, stable, { quoted_at: secondsAgo(f.clock, DUE_SEC) });
      await f.ref(stable);
      f.unionAnswers(stable, { item_id: `rawRef-${f.stableOf()}` });
      const before = await f.row(pool, stable);

      await f.round();

      expect(await f.row(pool, stable)).toEqual(before);
      expect(f.dropped).toEqual([]);
    });
  },
  TIMEOUT,
);

it.each(TEMPORARY)(
  '[BR-PROD-05] ③ 暂时失败（$label）：什么都不动，任务不报错、不靠队列重试',
  async ({ error }) => {
    await refreshCase(async (f) => {
      const stable = f.stableOf();
      const pool = await f.pool();
      await f.item(pool, stable, { quoted_at: secondsAgo(f.clock, DUE_SEC) });
      await f.ref(stable);
      f.unionFails(stable, error);
      const before = await f.row(pool, stable);

      await expect(f.round()).resolves.toBeUndefined();

      expect(await f.row(pool, stable)).toEqual(before);
      expect(f.dropped).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[BR-PROD-05] ③ 重解析暂时失败同样什么都不动',
  async () => {
    await refreshCase(async (f) => {
      const stable = f.stableOf();
      const pool = await f.pool();
      await f.item(pool, stable, { quoted_at: secondsAgo(f.clock, DUE_SEC) });
      f.searchItems.mockRejectedValue(
        new UnionError('rate_limited', 'synthetic rate limited', 'taobao'),
      );
      const before = await f.row(pool, stable);

      await expect(f.round()).resolves.toBeUndefined();

      expect(await f.row(pool, stable)).toEqual(before);
    });
  },
  TIMEOUT,
);

it.each(ANOMALIES)(
  '[BR-PRICE-11] 价格异常（$label）：这一行保持旧值，仍是 online，age 超龄后自然不展示',
  async ({ extra }) => {
    await refreshCase(async (f) => {
      const stable = f.stableOf();
      const pool = await f.pool();
      await f.item(pool, stable, { quoted_at: secondsAgo(f.clock, DUE_SEC) });
      await f.ref(stable);
      f.unionAnswers(stable, extra);
      const before = await f.row(pool, stable);

      await f.round();

      expect(f.asked).toEqual([`rawRef-${stable}`]);
      expect(await f.row(pool, stable)).toEqual(before);
    });
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 一个 key 失败不拦别的 key：同一轮里暂时失败、下架、引用失效和成功各走各的',
  async () => {
    await refreshCase(async (f) => {
      const [temporary, offShelf, expired, fine] = [
        f.stableOf(),
        f.stableOf(),
        f.stableOf(),
        f.stableOf(),
      ];
      const pool = await f.pool();
      for (const stable of [temporary, offShelf, expired, fine]) {
        await f.item(pool, stable, { quoted_at: secondsAgo(f.clock, DUE_SEC) });
        await f.ref(stable);
      }
      f.unionFails(temporary, TEMPORARY[0]!.error);
      f.unionFails(offShelf, new UnionError('item_unavailable', 'synthetic gone', 'taobao'));
      f.unionFails(expired, REF_EXPIRED[0]!.error);
      f.unionAnswers(fine);

      await expect(f.round()).resolves.toBeUndefined();

      expect(await f.row(pool, temporary)).toMatchObject({ status: 'online', price_fen: 8800n });
      expect(await f.row(pool, offShelf)).toMatchObject({ status: 'offline' });
      expect(await f.row(pool, expired)).toMatchObject({ status: 'online', price_fen: 8800n });
      expect(await f.row(pool, fine)).toMatchObject({ status: 'online', price_fen: 6000n });
    });
  },
  TIMEOUT,
);

it.each(INVALIDATIONS)(
  '[BR-PROD-07] 主动失效：刷新发现$label 时写入新值并删详情缓存',
  async ({ extra, stored }) => {
    await refreshCase(async (f) => {
      const stable = f.stableOf();
      const pool = await f.pool();
      await f.item(pool, stable, { quoted_at: secondsAgo(f.clock, DUE_SEC) });
      await f.ref(stable);
      f.unionAnswers(stable, extra);

      await f.round();

      expect(await f.row(pool, stable)).toMatchObject({
        status: 'online',
        quoted_at: f.clock.now(),
        ...stored,
      });
      expect(f.dropped).toEqual([[f.owner.appId, `tb:${stable}`]]);
    });
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 问联盟期间运营把行下线：写回只碰当时 online 的行，这一行不被改回 online',
  async () => {
    await refreshCase(async (f) => {
      const stable = f.stableOf();
      const pool = await f.pool();
      await f.item(pool, stable, { quoted_at: secondsAgo(f.clock, DUE_SEC) });
      await f.ref(stable);
      f.getItem.mockImplementationOnce(async () => {
        await f.db
          .updateTable('pool_items')
          .set({ status: 'offline', invalid_reason: '运营下线' })
          .where('app_id', '=', f.owner.appId)
          .where('pool_id', '=', pool)
          .execute();
        return f.answer(stable);
      });

      await f.round();

      expect(await f.row(pool, stable)).toMatchObject({
        status: 'offline',
        invalid_reason: '运营下线',
        price_fen: 8800n,
      });
    });
  },
  TIMEOUT,
);

it(
  '[BR-PRICE-11] 没有联盟适配的平台：跳过不报错，别的行照常刷新',
  async () => {
    await refreshCase(async (f) => {
      const stable = f.stableOf();
      const pool = await f.pool();
      const aged = secondsAgo(f.clock, DUE_SEC);
      await seedItem(f.db, f.owner, f.clock, pool, 'mt:synthetic1', {
        platform: 'meituan',
        quoted_at: aged,
      });
      await f.item(pool, stable, { quoted_at: aged });
      await f.ref(stable);
      f.unionAnswers(stable);
      const before = await itemRow(f.db, f.owner.appId, pool, 'mt:synthetic1');

      await expect(f.round()).resolves.toBeUndefined();

      expect(await itemRow(f.db, f.owner.appId, pool, 'mt:synthetic1')).toEqual(before);
      expect(await f.row(pool, stable)).toMatchObject({ final_price_fen: 5000n });
    });
  },
  TIMEOUT,
);
