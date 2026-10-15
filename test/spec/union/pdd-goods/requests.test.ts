import { expect, it } from 'vitest';
import {
  pddEnvelopeKey,
  unwrapPddResponse,
} from '../../../../apps/api/src/modules/union/infra/pdd/response.ts';
import {
  ctx,
  detail,
  envelope,
  read,
  recommend,
  ref,
  row,
  search,
  setup,
  shortParse,
  sources,
} from './kit.ts';

it.each([
  [search, 'goods_search_response', { goods_list: [row()] }],
  [detail, 'goods_detail_response', { goods_details: [row()] }],
  [recommend, 'goods_basic_detail_response', { list: [row()], total: 1 }],
  [shortParse, 'url', { url: 'https://mobile.yangkeduo.com/goods.html?goods_id=7345678901234' }],
] as const)('[AC-B1-04u-WIRE#1] %s 显式登记 probe 外层键 %s', (method, key, payload) => {
  expect(pddEnvelopeKey(method)).toBe(key);
  expect(
    unwrapPddResponse(method, {
      status: 200,
      headers: {},
      body: JSON.stringify({ [key]: payload }),
    }),
  ).toEqual(payload);
});

it('[AC-B1-04u-WIRE#2] 搜索 keyword 原样传送，page 从 1 开始，page_size 在 10–100 内', async () => {
  const { adapter, requests, transport } = setup((body) => envelope(body.type, [row()]));
  const controller = new AbortController();
  const page = await adapter.searchItems(
    { keyword: '合成 茶具 & 杯' },
    { ...ctx, signal: controller.signal },
  );
  expect(page.items).toHaveLength(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ type: search, keyword: '合成 茶具 & 杯', page: 1 });
  const size = requests[0]!.page_size;
  expect(Number.isInteger(size)).toBe(true);
  expect(size).toBeGreaterThanOrEqual(10);
  expect(size).toBeLessThanOrEqual(100);
  expect(transport.mock.calls[0]![0].signal).toBe(controller.signal);
});

it('[AC-B1-04u-WIRE#3] 详情按 goods_sign 请求，goods_details 数组映射成详情', async () => {
  const { adapter, requests, transport } = setup((body) => envelope(body.type, [row()]));
  const controller = new AbortController();
  const item = await adapter.getItem(ref, { ...ctx, signal: controller.signal });
  expect(item).toMatchObject(ref);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ type: detail, goods_sign: ref.goods_sign });
  expect(requests[0]).not.toHaveProperty('goods_id');
  expect(transport.mock.calls[0]![0].signal).toBe(controller.signal);
});

it('[AC-B1-04u-WIRE#4] 物料固定精选 channel_type=4，使用 list 外层列表并透传取消信号', async () => {
  const { adapter, requests, transport } = setup((body) => envelope(body.type, [row()]));
  const controller = new AbortController();
  expect(
    (await adapter.materialFeed({}, { ...ctx, signal: controller.signal })).items,
  ).toHaveLength(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ type: recommend, channel_type: 4 });
  expect(transport.mock.calls[0]![0].signal).toBe(controller.signal);
});

it('[AC-B1-04u-WIRE#5] 搜索 opaque 游标续用 list_id，翻页不重复且到尾停止', async () => {
  let pageSize: number | undefined;
  const { adapter, requests } = setup((body) => {
    expect(body.type).toBe(search);
    expect(body.keyword).toBe('合成分页');
    expect(Number.isInteger(body.page_size)).toBe(true);
    const size = body.page_size as number;
    expect(size).toBeGreaterThanOrEqual(10);
    expect(size).toBeLessThanOrEqual(100);
    pageSize ??= size;
    expect(size).toBe(pageSize);
    expect(Number.isInteger(body.page)).toBe(true);
    const page = body.page as number;
    expect(page).toBeGreaterThanOrEqual(1);
    expect(page).toBeLessThanOrEqual(3);
    if (page > 1) expect(body.list_id).toBe('synthetic-search-list');
    const all = Array.from({ length: size + 3 }, (_, index) =>
      row({
        goods_id: 7345678901000 + index,
        goods_sign: `synthetic-page-${index}`,
      }),
    );
    return {
      goods_search_response: {
        goods_list: all.slice((page - 1) * size, page * size),
        list_id: 'synthetic-search-list',
        total_count: all.length,
      },
    };
  });
  const first = await adapter.searchItems({ keyword: '合成分页' }, ctx);
  expect(first.items).toHaveLength(pageSize!);
  expect(first.nextCursor).toEqual(expect.any(String));
  expect(first.nextCursor).not.toBe('');
  const second = await adapter.searchItems({ keyword: '合成分页', cursor: first.nextCursor! }, ctx);
  expect(requests[1]).toMatchObject({ page: 2, list_id: 'synthetic-search-list' });
  expect(second.items).toHaveLength(3);
  const ids = [...first.items, ...second.items].map((item) => item.goods_id);
  expect(new Set(ids).size).toBe(ids.length);
  // 允许满页探测策略多读一个空页，但不得继续给出循环游标。
  if (second.nextCursor !== null) {
    const tail = await adapter.searchItems({ keyword: '合成分页', cursor: second.nextCursor }, ctx);
    expect(tail).toEqual({ items: [], nextCursor: null });
  }
  expect(requests.length).toBeLessThanOrEqual(3);
});

it('[AC-B1-04u-WIRE#6] 推荐 offset/limit 游标逐页前进，空页结束，不把 total 当商品数组', async () => {
  // recommend 的 probe 响应没有 list_id；此合成数据只提供 total/list，验证 offset 路径。
  let limit: number | undefined;
  const { adapter, requests } = setup((body) => {
    expect(body).toMatchObject({ type: recommend, channel_type: 4 });
    expect(Number.isInteger(body.limit)).toBe(true);
    expect(body.limit).toBeGreaterThan(0);
    const size = body.limit as number;
    limit ??= size;
    expect(size).toBe(limit);
    const offset = body.offset as number;
    expect(Number.isInteger(offset)).toBe(true);
    expect(offset).toBeGreaterThanOrEqual(0);
    const all = Array.from({ length: size + Math.min(3, size) }, (_, index) =>
      row({
        goods_id: 7345678901000 + index,
        goods_sign: `synthetic-feed-${index}`,
      }),
    );
    return {
      goods_basic_detail_response: { list: all.slice(offset, offset + size), total: all.length },
    };
  });
  const first = await adapter.materialFeed({}, ctx);
  expect(requests[0]).toMatchObject({ offset: 0 });
  expect(first.items).toHaveLength(limit!);
  expect(first.nextCursor).toEqual(expect.any(String));
  const second = await adapter.materialFeed({ cursor: first.nextCursor! }, ctx);
  expect(requests[1]).toMatchObject({ offset: limit });
  expect(second.items).toHaveLength(Math.min(3, limit!));
  const ids = [...first.items, ...second.items].map((item) => item.goods_id);
  expect(new Set(ids).size).toBe(ids.length);
  if (second.nextCursor !== null) {
    expect(await adapter.materialFeed({ cursor: second.nextCursor }, ctx)).toEqual({
      items: [],
      nextCursor: null,
    });
  }
  expect(requests.length).toBeLessThanOrEqual(3);
});

it.each(['search', 'feed'] as const)(
  '[AC-B1-04u-WIRE#7] %s 合法空列表输出空页和空游标',
  async (source) => {
    const { adapter } = setup((body) => envelope(body.type, []));
    const page =
      source === 'search'
        ? await adapter.searchItems({ keyword: '合成无结果' }, ctx)
        : await adapter.materialFeed({}, ctx);
    expect(page).toEqual({ items: [], nextCursor: null });
  },
);

it('[AC-B1-04u-WIRE#8] 空详情报 item_unavailable，不伪造 0 元商品', async () => {
  const { adapter } = setup((body) => envelope(body.type, []));
  await expect(adapter.getItem(ref, ctx)).rejects.toMatchObject({
    code: 'item_unavailable',
    platform: 'pdd',
  });
});

it.each(sources)(
  '[AC-B1-04u-WIRE#9] %s 列表形状损坏必须拒绝，不能伪装成成功空结果',
  async (source) => {
    const broken =
      source === 'search'
        ? { goods_search_response: { goods_list: {} } }
        : source === 'detail'
          ? { goods_detail_response: { goods_details: {} } }
          : { goods_basic_detail_response: { list: {} } };
    const { adapter } = setup(() => broken);
    await expect(read(adapter, source)).rejects.toMatchObject({
      code: 'invalid_dto',
      platform: 'pdd',
    });
  },
);

it.each(['search', 'feed'] as const)(
  '[AC-B1-04u-WIRE#10] %s 损坏游标不能重新从首页查询',
  async (source) => {
    const { adapter, transport } = setup(() => ({}));
    const result =
      source === 'search'
        ? adapter.searchItems({ keyword: '合成关键词', cursor: 'not-a-valid-cursor' }, ctx)
        : adapter.materialFeed({ cursor: 'not-a-valid-cursor' }, ctx);
    await expect(result).rejects.toMatchObject({ code: 'invalid_dto', platform: 'pdd' });
    expect(transport).not.toHaveBeenCalled();
  },
);

it('[AC-B1-04u-WIRE#11] goods.search 的 range_list 按 JSON 字符串传给已有请求底座', async () => {
  const { adapter, requests } = setup((body) => envelope(body.type, []));
  const range = [{ range_id: 1, range_from: 100, range_to: 900 }];
  // SearchQuery 只有 keyword/cursor；这里只验已获 probe 确认的底座数组序列化。
  expect(pddEnvelopeKey(search)).toBe('goods_search_response');
  await adapter.request(search, { keyword: '合成范围', page: 2, page_size: 10, range_list: range });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.range_list).toBe(JSON.stringify(range));
});
