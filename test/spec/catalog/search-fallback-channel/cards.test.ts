// B1-05n: what the fallback delivers. Cards follow the channel's own order and hold only the
// channel's products (BR-TEXT-17 细则「联盟物料频道」: no commission weight in our layers). Each entry
// becomes the candidate toCandidates derives (BR-PROD-03, BR-PROD-05); first `limit` candidates,
// and hasMore is the port's. The use case's filters through the single card entry stay as they are.
import { afterEach, expect, it, vi } from 'vitest';
import type { UnionItem } from '../../../../apps/api/src/modules/union/index.ts';
import {
  DECOY_TITLE,
  FALLBACK_LIMIT,
  JD_CHANNEL,
  JD_MODE_KEY,
  PDD_CHANNEL,
  QUOTED_AT,
  WHITELIST,
  fallbackSearch,
  feedRequest,
  fixture,
  jdItem,
  pddItem,
  position,
  refOf,
  tbItem,
  useCaseWhitelist,
} from './kit.ts';

afterEach(() => vi.restoreAllMocks());

it('[AC-B1-05n#5][BR-TEXT-17] 下发卡片顺序等于频道条目顺序（不按佣金、价格重排），只含该频道的商品，不混入通用物料流；搜索的排序与筛选不作用于兜底', async () => {
  useCaseWhitelist(WHITELIST);
  const f = fixture();
  f.fake('taobao').setPage({
    items: [
      position(tbItem('c', 3, { commissionBp: 100n, finalFen: 99_900n }), '3万+'),
      position(tbItem('a', 1, { commissionBp: 9_000n, finalFen: 100n }), null),
      position(tbItem('b', 2, { commissionBp: 5_000n, finalFen: 5_000n }), '12件'),
    ],
    hasMore: false,
  });
  const search = fallbackSearch(f);

  const plain = await search.run();
  const sorted = await search.run({ sort: 'final_price_asc', price_max_fen: 1 });

  for (const result of [plain, sorted]) {
    expect(result.items).toEqual([]);
    expect(result.fallback_items.map((card) => card.title)).toEqual([
      'synthetic-c',
      'synthetic-a',
      'synthetic-b',
    ]);
    expect(result.fallback_items.map((card) => card.product_key)).toEqual(['tb:3', 'tb:1', 'tb:2']);
    expect(result.fallback_items.map((card) => card.title)).not.toContain(DECOY_TITLE);
  }
});

it('[AC-B1-05n#6] 频道条目同样过统一出卡入口：异常价、无返利、重复商品不下发，不登记链接，其余保持相对顺序', async () => {
  useCaseWhitelist(WHITELIST);
  const f = fixture();
  const anomaly: UnionItem = {
    ...tbItem('anomaly', 1),
    price_status: 'anomaly',
    price_fen: 0n,
    coupon_fen: 0n,
    final_price_fen: 0n,
  };
  f.fake('taobao').setPage({
    items: [
      position(anomaly, '1'),
      position(tbItem('zero', 2), '2'),
      position(tbItem('good', 3), '3'),
      position(tbItem('again', 3), '3'),
      position(tbItem('other', 4), '4'),
    ],
    hasMore: false,
  });
  const search = fallbackSearch(f);
  search.quotes.set('synthetic-zero', { min: 0n, max: 0n });

  const result = await search.run();

  expect(result.fallback_items.map((card) => card.title)).toEqual([
    'synthetic-good',
    'synthetic-other',
  ]);
  expect(search.register).toHaveBeenCalledTimes(2);
  expect(search.warn).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'PRICE_ANOMALY' }),
    expect.any(String),
  );
});

it('[AC-B1-05n#7] 频道条目多于 10 条时兜底只下发前 10 条；搜索本身的 items、next_cursor、has_more 不受频道页影响', async () => {
  useCaseWhitelist(WHITELIST);
  const f = fixture();
  const names = Array.from({ length: 12 }, (_, index) => index + 1);
  f.fake('taobao').setPage({
    items: names.map((n) => position(tbItem(`p-${String(n)}`, n), null)),
    hasMore: true,
  });

  const result = await fallbackSearch(f).run();

  expect(result.fallback_items.map((card) => card.title)).toEqual(
    names.slice(0, FALLBACK_LIMIT).map((n) => `synthetic-p-${String(n)}`),
  );
  expect(result).toMatchObject({ items: [], next_cursor: null, has_more: false });
});

it('[AC-B1-05n#8] 候选的 ref 同 toCandidates：淘宝、京东 item 与 sku 口径、拼多多的 productKey 与 rawItemId，rawFetchedAt 为 quoted_at，receivedAt 为取数时的时钟，source=search，候选不带 salesText', async () => {
  const f = fixture();
  const upstream = f.upstream();
  f.clock.advanceMs(5_000);
  const receivedAt = f.clock.now().toISOString();
  const tb = tbItem('ref', 101, { quotedAt: QUOTED_AT });
  const jd = jdItem('ref', 102);
  const signed = pddItem('signed', 103);
  const unsigned = pddItem('unsigned', 104, null);
  f.fake('taobao').setPage({ items: [position(tb, '99+')], hasMore: false });
  f.fake('jd').setPage({ items: [position(jd, '98+')], hasMore: false });
  f.fake('pdd').setPage({
    items: [position(signed, '97+'), position(unsigned, null)],
    hasMore: false,
  });
  const jdRequest = feedRequest({ platform: 'jd', channelId: JD_CHANNEL });

  expect((await upstream.materialFeed(feedRequest())).items).toEqual([
    { item: tb, ref: refOf(tb, receivedAt, 'tb:101', 'synthetic-ref-101') },
  ]);
  expect((await upstream.materialFeed(jdRequest)).items).toEqual([
    { item: jd, ref: refOf(jd, receivedAt, 'jd:i_102', 'synthetic_102') },
  ]);
  f.settings.set(JD_MODE_KEY, 'sku');
  expect((await upstream.materialFeed(jdRequest)).items).toEqual([
    { item: jd, ref: refOf(jd, receivedAt, 'jd:sku102', 'sku102') },
  ]);
  expect(
    (await upstream.materialFeed(feedRequest({ platform: 'pdd', channelId: PDD_CHANNEL }))).items,
  ).toEqual([
    { item: signed, ref: refOf(signed, receivedAt, 'pdd:g103', 'sign-103') },
    { item: unsigned, ref: refOf(unsigned, receivedAt, 'pdd:g104', 'g104') },
  ]);
});

it('[AC-B1-05n#9] 推导不出 product_key 或平台不符的条目丢掉，其余保持相对顺序', async () => {
  const f = fixture();
  const blankId: UnionItem = { ...tbItem('blank-id', 0), item_id: '' };
  f.fake('taobao').setPage({
    items: [
      position(tbItem('first', 41), 'A'),
      position(jdItem('foreign', 42), 'X'),
      position(blankId, 'X'),
      position(tbItem('second', 43), null),
    ],
    hasMore: false,
  });

  const page = await f.upstream().materialFeed(feedRequest());

  expect(page.items.map((candidate) => candidate.item.title)).toEqual([
    'synthetic-first',
    'synthetic-second',
  ]);
});

it('[AC-B1-05n#10] 只取前 limit 条候选：丢掉的条目不占名额，多出的条目不改 hasMore', async () => {
  const f = fixture();
  const blankId: UnionItem = { ...tbItem('blank-id', 0), item_id: '' };
  f.fake('taobao').setPage({
    items: [
      position(blankId, 'X'),
      position(tbItem('a', 1), '1'),
      position(jdItem('foreign', 2), 'X'),
      position(tbItem('b', 2), '2'),
      position(tbItem('c', 3), '3'),
    ],
    hasMore: false,
  });

  const page = await f.upstream().materialFeed(feedRequest({ limit: 2 }));

  expect(page.items.map((candidate) => candidate.item.title)).toEqual([
    'synthetic-a',
    'synthetic-b',
  ]);
  expect(page.hasMore).toBe(false);
});

it('[AC-B1-05n#11] hasMore 取端口的 hasMore，与通用物料流的游标无关', async () => {
  const f = fixture();
  const upstream = f.upstream();
  const fake = f.fake('taobao');

  fake.setPage({ items: [position(tbItem('a', 1), '1')], hasMore: true });
  fake.setFeedCursor(null);
  expect((await upstream.materialFeed(feedRequest())).hasMore).toBe(true);

  fake.setPage({ items: [position(tbItem('a', 1), '1')], hasMore: false });
  fake.setFeedCursor('synthetic-next');
  expect((await upstream.materialFeed(feedRequest())).hasMore).toBe(false);
});
