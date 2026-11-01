import { expect, it } from 'vitest';
import {
  convertAll,
  couliItemId,
  ctx,
  DETAIL,
  dtkBack,
  dtkFront,
  dtkGoodsId,
  dtkRow,
  endpoint,
  expectTrueIdentities,
  expectWarned,
  formOf,
  goodsNumber,
  search,
  searchData,
  searchRows,
  sent,
  setup,
  topBody,
  topError,
  topFields,
  topIdLists,
  topRow,
  visible,
  type Row,
} from './kit.ts';

// 商品 ID 换算（D10-504）：大淘客 goodsId 经凑狸 TOP taobao.tbk.item.info.upgrade.get 换成凑狸口径
// item_id；换不到的条目不返回，不用大淘客 ID 兜底；进程内映射缓存（命中不再请求、失败不写缓存、带 TTL）。

const DAY_MS = 86_400_000;

function rows(...numbers: number[]): Row[] {
  return numbers.map((n) => dtkRow(n));
}

it('[AC-B1-04zh#10] item_id = 凑狸口径 ID（按搜索顺序）；换算一次 TOP：item_id 逗号连接、biz_scene_id 1，POST 淘宝网关，归档 kind = query', async () => {
  const { h, page } = await searchRows(rows(5, 2, 9));
  expect(page.items.map((item) => item.item_id)).toEqual([
    couliItemId(5),
    couliItemId(2),
    couliItemId(9),
  ]);
  expect(page.items.every((item) => item.platform === 'taobao')).toBe(true);
  expect(h.taobaoTransport).toHaveBeenCalledTimes(1);
  const request = sent(h.taobaoTransport);
  expect(request.method).toBe('POST');
  expect(request.url).toBe(endpoint.baseUrl);
  expect(formOf(request)['method']).toBe(DETAIL);
  expect(topFields(h)).toEqual({
    item_id: [dtkGoodsId(5), dtkGoodsId(2), dtkGoodsId(9)].join(','),
    biz_scene_id: '1',
  });
  expect(request.archive).toEqual({ appId: ctx.appId, kind: 'query' });
});

it('[AC-B1-04zh#11] 大淘客 goodsId（含前段、后段）不出现在结果任何字段里；不带 goods_id / goods_sign / itemId / skuId', async () => {
  const { page } = await searchRows(rows(1, 2, 3));
  expect(page.items).toHaveLength(3);
  const shown = visible(page);
  for (const n of [1, 2, 3]) {
    expect(shown).not.toContain(dtkGoodsId(n));
    expect(shown).not.toContain(dtkFront(n));
    expect(shown).not.toContain(dtkBack(n));
  }
  for (const item of page.items) {
    for (const key of ['goods_id', 'goods_sign', 'itemId', 'skuId']) {
      expect(Object.hasOwn(item, key), key).toBe(false);
    }
  }
});

it('[AC-B1-04zh#12] 整页 20 条：一次换算请求带全部 20 个 goodsId，每批不超过 20 个、每个只出现一次', async () => {
  const numbers = Array.from({ length: 20 }, (_unused, i) => i + 1);
  const { h, page } = await searchRows(rows(...numbers));
  expect(expectTrueIdentities(page)).toEqual(numbers);
  const lists = topIdLists(h);
  expect(lists).toHaveLength(1);
  for (const list of lists) expect(list.length).toBeLessThanOrEqual(20);
  expect(lists.flat()).toEqual(numbers.map(dtkGoodsId));
});

it('[AC-B1-04zh#13] 换不到的条目（详情无该商品）不返回、不用大淘客 ID 兜底；其余条目 ID 与商品一一对应', async () => {
  const unavailable = (goodsId: string) =>
    goodsNumber(goodsId) === 2 ? undefined : convertAll(goodsId);
  const { h, page } = await searchRows(rows(1, 2, 3), { available: unavailable });
  const numbers = expectTrueIdentities(page);
  expect(numbers).not.toContain(2);
  expect(visible(page)).not.toContain('DtkSynth');
  // 换算请求只问过这三个 goodsId。
  expect(new Set(topIdLists(h).flat())).toEqual(new Set([1, 2, 3].map(dtkGoodsId)));
  expect(h.taobaoTransport.mock.calls.length).toBeGreaterThanOrEqual(1);
});

it('[AC-B1-04zh#14] 单个 goodsId 换算得 15 / 50001 → 该条不返回，整页照常（空页不报错）', async () => {
  const { page } = await searchRows(rows(4), { available: () => undefined });
  expect(page.items).toEqual([]);
  expect(page.nextCursor).toBeNull();
});

it('[AC-B1-04zh#15] 返回条数与请求相等时按位置对应：某条 item_id 缺失 / 空白只丢这一条，其余按位置取 ID', async () => {
  const topReply = (ids: readonly string[]) =>
    topBody(
      ids.map((id, i) => {
        const row = topRow(convertAll(id) ?? 'unexpected');
        if (i === 1) row['item_id'] = '   ';
        if (i === 3) delete row['item_id'];
        return row;
      }),
    );
  const { page } = await searchRows(rows(11, 12, 13, 14, 15), { topReply });
  expect(expectTrueIdentities(page)).toEqual([11, 13, 15]);
});

it('[AC-B1-04zh#16] 整批换算失败（15 / 50001 或 results 为空）→ 本页无条目、不报错；满页时 nextCursor 照给', async () => {
  const numbers = Array.from({ length: 20 }, (_unused, i) => i + 1);
  const replies: readonly Row[] = [
    topError(15, 50001),
    topBody([]),
    { tbk_item_info_upgrade_get_response: { request_id: 'synthetic-request-id' } },
  ];
  for (const reply of replies) {
    const h = setup({ data: () => searchData(rows(...numbers), 165, 1), topReply: () => reply });
    const page = await search(h);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).not.toBeNull();
  }
});

it.each([
  ['含逗号', `${dtkGoodsId(2)},${dtkGoodsId(9)}`],
  ['空白', '   '],
  ['空串', ''],
  ['null', null],
  ['数字', 12345],
])(
  '[AC-B1-04zh#17] goodsId %s → 该条跳过并告警 invalid_item，不进换算请求；其余条目照常',
  async (_label, goodsId) => {
    const { h, page } = await searchRows([dtkRow(1), dtkRow(2, { goodsId }), dtkRow(3)]);
    expect(expectTrueIdentities(page)).toEqual([1, 3]);
    expectWarned(h, 'invalid_item');
    expect(topIdLists(h).flat().sort()).toEqual([dtkGoodsId(1), dtkGoodsId(3)].sort());
  },
);

it('[AC-B1-04zh#18] 缓存命中不重复请求：同一适配器再次搜到同样商品，只调大淘客、不再调 TOP，ID 不变', async () => {
  const h = setup({ data: () => searchData(rows(1, 2, 3), 3, 1) });
  const first = await search(h);
  expect(expectTrueIdentities(first)).toEqual([1, 2, 3]);
  expect(h.taobaoTransport).toHaveBeenCalledTimes(1);

  h.clock.advanceMs(60_000);
  const second = await search(h);
  expect(second.items.map((item) => item.item_id)).toEqual(first.items.map((item) => item.item_id));
  expect(h.dataokeTransport).toHaveBeenCalledTimes(2);
  expect(h.taobaoTransport).toHaveBeenCalledTimes(1);
});

it('[AC-B1-04zh#19] 部分命中：只把未缓存的 goodsId 送去换算', async () => {
  let round = 0;
  const h = setup({
    data: () => (round === 0 ? searchData(rows(1, 2), 2, 1) : searchData(rows(2, 3, 1), 3, 1)),
  });
  await search(h);
  round = 1;
  const page = await search(h);
  expect(expectTrueIdentities(page)).toEqual([2, 3, 1]);
  expect(h.taobaoTransport).toHaveBeenCalledTimes(2);
  expect(topIdLists(h)[1]).toEqual([dtkGoodsId(3)]);
});

it('[AC-B1-04zh#20] 换算失败不写缓存：先换不到（不返回），之后能换到时重新请求并返回', async () => {
  let open = false;
  const h = setup({
    data: () => searchData(rows(7), 1, 1),
    available: (goodsId) => (open ? convertAll(goodsId) : undefined),
  });
  const first = await search(h);
  expect(first.items).toEqual([]);
  const failedCalls = h.taobaoTransport.mock.calls.length;
  expect(failedCalls).toBeGreaterThanOrEqual(1);
  open = true;
  const second = await search(h);
  expect(expectTrueIdentities(second)).toEqual([7]);
  expect(h.taobaoTransport.mock.calls.length).toBeGreaterThan(failedCalls);
  expect(topIdLists(h).at(-1)).toEqual([dtkGoodsId(7)]);
});

it('[AC-B1-04zh#21] 缓存带 TTL、按注入时钟计：一分钟内命中，一年后过期重新换算', async () => {
  const h = setup({ data: () => searchData(rows(8), 1, 1) });
  await search(h);
  h.clock.advanceMs(60_000);
  await search(h);
  expect(h.taobaoTransport).toHaveBeenCalledTimes(1);

  h.clock.advanceMs(365 * DAY_MS);
  const later = await search(h);
  expect(expectTrueIdentities(later)).toEqual([8]);
  expect(h.taobaoTransport).toHaveBeenCalledTimes(2);
});

it('[AC-B1-04zh#22] 换算响应条数少于请求（无法按位置对应）时，不把任何 ID 安到别的商品上', async () => {
  // 真实的凑狸详情：只返回能换到的商品、按请求顺序；第 1、3 个换不到。
  const available = (goodsId: string) => {
    const n = goodsNumber(goodsId);
    return n === 21 || n === 23 ? undefined : convertAll(goodsId);
  };
  const { page } = await searchRows(rows(21, 22, 23, 24), { available });
  const numbers = expectTrueIdentities(page);
  expect(numbers.every((n) => n === 22 || n === 24)).toBe(true);
  expect(visible(page)).not.toContain('DtkSynth');
  // 对照：同样四条全部换得到时全部返回（排除「一律丢弃」）。
  const all = await searchRows(rows(21, 22, 23, 24));
  expect(expectTrueIdentities(all.page)).toEqual([21, 22, 23, 24]);
});

it.each([
  ['3 个只回 2 个，中间那个下架', [31, 32, 33], [32]],
  ['3 个只回 2 个，第一个下架', [41, 42, 43], [41]],
  ['4 个只回 2 个，第 1、3 个下架', [21, 22, 23, 24], [21, 23]],
] as [string, number[], number[]][])(
  '[AC-B1-04zh#41] 换算返回行数少于请求的 goodsId 数（%s）→ 换到的条目照常返回（不丢整批），下架的不出现',
  async (_label, numbers, gone) => {
    // 真实的凑狸详情：只返回能换到的商品、按请求顺序，下架的不回行。
    const available = (goodsId: string) => {
      const n = goodsNumber(goodsId);
      return n !== undefined && gone.includes(n) ? undefined : convertAll(goodsId);
    };
    const { h, page } = await searchRows(rows(...numbers), { available });
    const kept = numbers.filter((n) => !gone.includes(n));
    // 第一次换算就是整批请求，上游确实少回了行。
    expect(topIdLists(h)[0]).toEqual(numbers.map(dtkGoodsId));
    // 先断言非空，再断言每条都满足（避免对空数组的空真）。
    expect(page.items.length).toBeGreaterThan(0);
    const returned = expectTrueIdentities(page);
    expect(returned.length).toBeGreaterThan(0);
    expect(returned.every((n) => kept.includes(n))).toBe(true);
    // 返回的 item_id 集合恰为换到的那几个。
    const ids = page.items.map((item) => item.item_id);
    expect(ids).toHaveLength(kept.length);
    expect(new Set(ids)).toEqual(new Set(kept.map(couliItemId)));
    for (const n of gone) expect(ids).not.toContain(couliItemId(n));
    expect(visible(page)).not.toContain('DtkSynth');
  },
);
