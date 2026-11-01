// B1-05w: which rows open BR-PROD-05 ③ and what it leaves in them, over real product_refs and
// pool_items: one app's rows never serve another (编排 12:06 ③ 第 2、4 条), an unqualified pool row with
// a stale product_refs row still re-parses, 重新解析步骤 4 writes through the conditional upsert, and
// 引用失效 touches nothing.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import { UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { PRODUCT_KEY, item } from '../detail/kit.ts';
import { rejection } from '../hot-rank/kit.ts';
import {
  MAX_AGE_SEC,
  OFF_SHELF_REASON,
  TIMEOUT,
  itemRow,
  secondsAgo,
  usePoolDatabase,
} from '../product-pool-read/kit.ts';
import {
  CANONICAL_URL,
  NEW_RAW,
  STORED_TITLE,
  askedRaws,
  found,
  onePage,
  unionCalls,
} from './kit.ts';
import { AGED_SEC, rowsCase } from './rows-kit.ts';

const h = usePoolDatabase(createTestDatabase);
const OTHER_RAW = 'synthetic-foreign-synthetic001';
const OTHER_TITLE = '别的应用的标题';

const UNQUALIFIED = [
  { label: '下线', extra: { status: 'offline', invalid_reason: OFF_SHELF_REASON } },
  { label: '佣金率为空', extra: { commission_rate_bp: null } },
] as const;

it(
  '[B1-05w#35][BR-PROD-05] 跨 App：这个 App 没有行，别的 App 有新鲜 product_refs 和合格池行 → 30143，不问联盟',
  async () => {
    const f = await rowsCase(h);
    const other = await f.other();
    await f.staleRef(other, {
      raw_item_id: OTHER_RAW,
      title: OTHER_TITLE,
      refreshed_at: f.clock.now(),
    });
    await f.poolRow(other);

    expect(await rejection(() => f.run())).toMatchObject({ code: 30143 });

    expect(unionCalls(f.fake)).toBe(0);
    expect(f.rows).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[B1-05w#36][BR-PROD-05] 跨 App：别的 App 的新鲜原串不借用，按本 App 的标题重解析，写本 App 的行，别的 App 的行不动',
  async () => {
    const f = await rowsCase(h);
    const other = await f.other();
    await f.staleRef();
    await f.staleRef(other, {
      raw_item_id: OTHER_RAW,
      title: OTHER_TITLE,
      refreshed_at: f.clock.now(),
    });
    const foreign = await f.refRow(other);

    const card = await f.run();

    expect(card).toMatchObject({ product_key: PRODUCT_KEY, stale: false });
    expect(f.searchItems.mock.calls[0]?.[0]).toMatchObject({ keyword: STORED_TITLE });
    expect(f.searchItems.mock.calls[0]?.[1]).toMatchObject({ appId: f.owner.appId });
    expect(askedRaws(f.fake)).toEqual([NEW_RAW]);
    expect(await f.refRow()).toMatchObject({ raw_item_id: NEW_RAW });
    expect(await f.refRow(other)).toEqual(foreign);
  },
  TIMEOUT,
);

it.each(UNQUALIFIED)(
  '[B1-05w#37][BR-PROD-05] 池行不合格（$label）但有 product_refs 旧行 → 照样重解析出卡',
  async ({ extra }) => {
    const f = await rowsCase(h);
    await f.staleRef();
    await f.poolRow(f.owner, extra);

    const card = await f.run();

    expect(card).toMatchObject({ stale: false, final_price_fen: 2990 });
    expect(f.searchItems).toHaveBeenCalledTimes(1);
  },
  TIMEOUT,
);

it(
  '[B1-05w#38][BR-PROD-05] 池行超龄但有 product_refs 旧行 → 照样重解析出卡',
  async () => {
    const f = await rowsCase(h);
    await f.staleRef();
    await f.poolRow(f.owner, { quoted_at: secondsAgo(f.clock, MAX_AGE_SEC + 1) });

    expect(await f.run()).toMatchObject({ stale: false, final_price_fen: 2990 });
    expect(f.searchItems).toHaveBeenCalledTimes(1);
  },
  TIMEOUT,
);

it.each(UNQUALIFIED)(
  '[B1-05w#39][BR-PROD-05] 编排第 4 条：池行不合格（$label）又没有 product_refs 行 → 30143，不问联盟',
  async ({ extra }) => {
    const f = await rowsCase(h);
    await f.poolRow(f.owner, extra);

    expect(await rejection(() => f.run())).toMatchObject({ code: 30143 });

    expect(unionCalls(f.fake)).toBe(0);
  },
  TIMEOUT,
);

it(
  '[B1-05w#40][BR-PROD-05] 步骤 4：标题重解析成功 → 行里是新原串，refreshed_at 是最后一次联盟响应的接收时刻',
  async () => {
    const f = await rowsCase(h);
    await f.staleRef();
    f.getItem.mockImplementation(async () => {
      f.clock.advanceMs(2000);
      return found();
    });

    await f.run();

    expect(await f.refRow()).toMatchObject({ raw_item_id: NEW_RAW, refreshed_at: f.clock.now() });
  },
  TIMEOUT,
);

it(
  '[B1-05w#41][BR-PROD-05] 步骤 1：按链接重解析成功后 canonical_url 留在行里，下一次过期还能走链接',
  async () => {
    const f = await rowsCase(h);
    await f.staleRef(f.owner, { canonical_url: CANONICAL_URL });
    f.getItem.mockImplementation(async () => {
      f.clock.advanceMs(2000);
      return found();
    });

    await f.run();

    expect(f.resolveLink).toHaveBeenCalledTimes(1);
    expect(await f.refRow()).toMatchObject({
      raw_item_id: NEW_RAW,
      canonical_url: CANONICAL_URL,
      refreshed_at: f.clock.now(),
    });
  },
  TIMEOUT,
);

it.each([
  { label: '第①步 item_ref', tapped: true },
  { label: '第②步 product_refs', tapped: false },
])(
  '[B1-05w#68][BR-PROD-05] 步骤 1：详情走$label 成功、时钟前进也不抹掉 canonical_url，1801 秒后重解析还走链接',
  async ({ tapped }) => {
    const f = await rowsCase(h);
    const received = secondsAgo(f.clock, tapped ? AGED_SEC : 60);
    await f.staleRef(f.owner, {
      canonical_url: CANONICAL_URL,
      raw_fetched_at: received,
      refreshed_at: received,
    });
    f.getItem.mockImplementation(async () => {
      f.clock.advanceMs(2000);
      return found({ quoted_at: f.clock.now().toISOString() });
    });

    await f.run(tapped ? { item_ref: f.issue() } : {});

    expect(f.resolveLink).not.toHaveBeenCalled();
    expect(await f.refRow()).toMatchObject({
      canonical_url: CANONICAL_URL,
      refreshed_at: f.clock.now(),
    });

    f.clock.advanceMs(AGED_SEC * 1000);
    await f.run();

    expect(f.resolveLink.mock.calls.map(([url]) => url)).toEqual([CANONICAL_URL]);
    expect(f.searchItems).not.toHaveBeenCalled();
  },
  TIMEOUT,
);

it(
  '[B1-05w#42][BR-PROD-05][BR-PRICE-11] 步骤 4：解析成功、getItem 超时 → 50401，新原串已落行且 source=detail，重试走第②步，不再重解析',
  async () => {
    const f = await rowsCase(h);
    await f.staleRef();
    f.getItem.mockRejectedValueOnce(
      new GovernanceError('timeout', 'union:taobao:online', 'synthetic timeout'),
    );

    expect(await rejection(() => f.run())).toMatchObject({ code: 50401 });
    expect(await f.refRow()).toMatchObject({ raw_item_id: NEW_RAW, source: 'detail' });

    expect(await f.run()).toMatchObject({ stale: false });
    expect(f.searchItems).toHaveBeenCalledTimes(1);
    expect(askedRaws(f.fake)).toEqual([NEW_RAW, NEW_RAW]);
  },
  TIMEOUT,
);

it(
  '[B1-05w#43][BR-PROD-05] 写入是条件更新：解析期间别的请求写了更新的行，解析结果不覆盖它',
  async () => {
    const f = await rowsCase(h);
    await f.staleRef();
    const newer = new Date(f.clock.now().getTime() + 60_000);
    f.searchItems.mockImplementation(async () => {
      await h.db
        .updateTable('product_refs')
        .set({ raw_item_id: OTHER_RAW, refreshed_at: newer })
        .where('app_id', '=', f.owner.appId)
        .where('product_key', '=', PRODUCT_KEY)
        .execute();
      f.clock.advanceMs(2000);
      return onePage();
    });

    await f.run();

    expect(await f.refRow()).toMatchObject({ raw_item_id: OTHER_RAW, refreshed_at: newer });
  },
  TIMEOUT,
);

it(
  '[B1-05w#44][BR-PROD-05] 结果分类②：搜不到同键 → 30143，product_refs 行不动，池行仍 online，不出卡',
  async () => {
    const f = await rowsCase(h);
    await f.staleRef();
    const pool = await f.poolRow();
    const before = await f.refRow();
    f.searchItems.mockResolvedValue(onePage([item({ item_id: 'synthetic-other002' })]));

    expect(await rejection(() => f.run())).toMatchObject({ code: 30143 });

    expect(await f.refRow()).toEqual(before);
    expect(await itemRow(h.db, f.owner.appId, pool, PRODUCT_KEY)).toMatchObject({
      status: 'online',
      invalid_reason: null,
    });
    expect(f.rows).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[B1-05w#45][BR-PROD-05] 结果分类③：联盟答不了、都没有 → 50401，product_refs 行不动，不出卡',
  async () => {
    const f = await rowsCase(h);
    await f.staleRef();
    const before = await f.refRow();
    f.searchItems.mockRejectedValue(
      new UnionError('upstream_unavailable', 'synthetic outage', 'taobao'),
    );

    expect(await rejection(() => f.run())).toMatchObject({ code: 50401 });

    expect(await f.refRow()).toEqual(before);
    expect(f.rows).toEqual([]);
  },
  TIMEOUT,
);
