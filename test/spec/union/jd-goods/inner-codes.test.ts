import { expect, it } from 'vitest';
import { expectRedacted, unionFailure } from '../jd-core/kit.ts';
import { jsonText } from '../jd-orders/kit.ts';
import {
  ctx,
  failure,
  itemRef,
  listing,
  listOf,
  mode,
  reply,
  skuId,
  unionLink,
  wire,
  type Answer,
} from './kit.ts';

// 官方错误码表：201「未查询到满足条件的商品」是空结果，202「已达到分页上限」是 searchItems 翻到头，
// 都不是错误。数字 code 与同值字符串同等处理（底座约定）。
const keyword = '合成关键词';
const upstreamText = 'upstream-text-marker';
const urlDigits = '100099999999';

const empties: readonly (readonly [string, Answer])[] = [
  ['数字 201', () => reply(failure('201', upstreamText))],
  ['字符串 201', () => reply(jsonText({ code: '201', message: upstreamText }))],
];
const pageEnds: readonly (readonly [string, Answer])[] = [
  ['数字 202', () => reply(failure('202', upstreamText))],
  ['字符串 202', () => reply(jsonText({ code: '202', message: upstreamText }))],
];
const stops = [...empties, ...pageEnds];
const linkMisses = [unionLink, `https://item.jd.com/${urlDigits}.html`].flatMap((link) =>
  empties.map(([name, answer]) => [link, name, answer] as const),
);

it.each(empties)(
  '[AC-B1-04zc#76] 搜索遇内层 %s：空页、翻页结束，只发一次，不告警',
  async (_name, answer) => {
    const { adapter, requests, warn } = wire(answer);
    expect(await adapter.searchItems({ keyword }, ctx)).toEqual({ items: [], nextCursor: null });
    expect(requests).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  },
);

it.each(empties)('[AC-B1-04zc#77] getItem 遇内层 %s → item_unavailable', async (_name, answer) => {
  const { adapter, requests } = wire(answer);
  const error = await unionFailure(() => adapter.getItem(itemRef, ctx), 'item_unavailable');
  expectRedacted(error, [upstreamText]);
  expect(requests).toHaveLength(1);
});

it('[AC-B1-04zc#78] sku 模式 getItem 遇内层 201 → item_unavailable，不用 sceneId=2', async () => {
  const { adapter, requests } = wire(() => reply(failure('201')), mode('sku'));
  await unionFailure(() => adapter.getItem({ platform: 'jd', skuId }, ctx), 'item_unavailable');
  expect(requests.length).toBeLessThanOrEqual(1);
  for (const body of requests) expect(body).toMatchObject({ sceneId: 1 });
});

it.each(linkMisses)(
  '[AC-B1-04zc#79] %s 遇内层 %s → link_unrecognized，不从链接抽 skuId 猜',
  async (link, _name, answer) => {
    const { adapter, requests } = wire(answer);
    const error = await unionFailure(() => adapter.resolveLink(link, ctx), 'link_unrecognized');
    expectRedacted(error, [link, urlDigits, upstreamText]);
    expect(requests).toHaveLength(1);
  },
);

it.each(pageEnds)(
  '[AC-B1-04zc#80] 搜索遇内层 %s：到此结束，items 为空、nextCursor 为 null，不报错、不告警',
  async (_name, answer) => {
    const { adapter, requests, warn } = wire(answer);
    expect(await adapter.searchItems({ keyword }, ctx)).toEqual({ items: [], nextCursor: null });
    expect(requests).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  },
);

it.each(stops)(
  '[AC-B1-04zc#81] 第二页遇内层 %s：第一页照常，第二页结束翻页',
  async (_name, stop) => {
    const { adapter, requests } = wire((body) => {
      const size = Number(body.pageSize);
      return Number(body.pageIndex) === 1 ? listing(listOf(size), size * 3) : stop(body);
    });
    const first = await adapter.searchItems({ keyword }, ctx);
    expect(first.items).toHaveLength(Number(requests[0]!.pageSize));
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await adapter.searchItems({ keyword, cursor: first.nextCursor! }, ctx);
    expect(second).toEqual({ items: [], nextCursor: null });
    expect(requests).toHaveLength(2);
  },
);

it.each(['203', '204', '2011'])(
  '[AC-B1-04zc#82] 搜索遇内层 %s → upstream_rejected：只有 201、202 算空',
  async (code) => {
    const { adapter, requests } = wire(() => reply(failure(code)));
    await unionFailure(() => adapter.searchItems({ keyword }, ctx), 'upstream_rejected');
    expect(requests).toHaveLength(1);
  },
);
