import { expect, it } from 'vitest';
import { endpoint, formFields, sent, unionFailure } from '../jd-core/kit.ts';
import { num } from '../jd-orders/kit.ts';
import {
  ctx,
  expectNoMarkers,
  failure,
  listing,
  method,
  mode,
  otherItemId,
  otherSkuId,
  reply,
  row,
  skuId,
  success,
  unionLink,
  wholeItemId,
  wire,
  withPrice,
  type Answer,
} from './kit.ts';

// CAP-JD-01：sceneId 只用 1。不跟随跳转、不抓页面，不从链接里抽 skuId 猜；
// goods.link.query 不用，所有上游请求都是发往网关的 goods.query。
const urlDigits = '100099999999';
const mainSiteLinks = [
  `https://item.jd.com/${urlDigits}.html`,
  `https://item.m.jd.com/product/${urlDigits}.html`,
  'https://3.cn/synth-01',
];
const keywordLinks = [
  unionLink,
  'https://union-click.jd.com/jdc?e=synthetic',
  'https://example.invalid/some-page',
];
const notRecognized: readonly (readonly [string, Answer])[] = [
  ['内层 410', () => reply(failure('410'))],
  ['内层 411', () => reply(failure('411'))],
  ['空数组', () => listing([])],
  ['data 缺失', () => reply(success())],
];
const mainSiteMisses = mainSiteLinks.flatMap((link) =>
  notRecognized.map(([name, answer]) => [link, name, answer] as const),
);
const other = row({ itemId: otherItemId, skuId: num(otherSkuId) });
const skuLess: readonly (readonly [string, Answer])[] = [
  ['第一条没有 skuId', () => listing([row({ skuId: undefined })])],
  ['第一条没有 skuId、第二条有', () => listing([row({ skuId: undefined }), other])],
];
const skuLessCases = keywordLinks.flatMap((link) =>
  skuLess.map(([name, answer]) => [link, name, answer] as const),
);

/** 看着像 jingfen 详情页、其实不是：必须走 keyword，不能把路径当 itemId。 */
const lookalikes = [
  `https://jingfen.jd.com.evil.invalid/detail/${wholeItemId}.html`,
  `https://evil.invalid/jingfen.jd.com/detail/${wholeItemId}.html`,
  `https://jingfen.jd.com@evil.invalid/detail/${wholeItemId}.html`,
  `https://jingfen.jd.com/other/${wholeItemId}.html`,
  `https://jingfen.jd.com/detail/${wholeItemId}.htm`,
  `https://jingfen.jd.com/detail/x/${wholeItemId}.html`,
];

it.each([
  `https://jingfen.jd.com/detail/${wholeItemId}.html`,
  `http://jingfen.jd.com/detail/${wholeItemId}.html`,
  `jingfen.jd.com/detail/${wholeItemId}.html`,
  `https://jingfen.jd.com/detail/${wholeItemId}.html?from=share`,
])('[AC-B1-04zc#53] %s 直接得 itemId，不取凭据、不调上游', async (link) => {
  const { adapter, credentials, transport } = wire(() => listing([]));
  const { item } = await adapter.resolveLink(link, ctx);
  expect(item).toMatchObject({ platform: 'jd', item_id: wholeItemId, itemId: wholeItemId });
  expect(credentials).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it.each(lookalikes)('[AC-B1-04zc#54] 仿冒的 %s 走 keyword，不当 jingfen 链接', async (link) => {
  const { adapter, requests } = wire(() => listing([]));
  await unionFailure(() => adapter.resolveLink(link, ctx), 'link_unrecognized');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ keyword: link, sceneId: 1 });
});

it.each(keywordLinks)(
  '[AC-B1-04zc#55] %s 原样作为 keyword 走 goods.query，取第一条，只发一次',
  async (link) => {
    const rows = [row(), row({ itemId: otherItemId, skuId: num(otherSkuId) })];
    const { adapter, requests, transport } = wire(() => listing(rows));
    const { item } = await adapter.resolveLink(link, ctx);
    expect(item).toMatchObject({
      platform: 'jd',
      item_id: wholeItemId,
      itemId: wholeItemId,
      skuId,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ keyword: link, sceneId: 1, pageIndex: 1 });
    expect(sent(transport).url).toBe(endpoint.baseUrl);
    expect(sent(transport).method).toBe('POST');
    expect(formFields(sent(transport)).method).toBe(method);
  },
);

it.each(mainSiteLinks)('[AC-B1-04zc#56] 主站链接 %s 照样走 keyword，身份只取响应', async (link) => {
  const { adapter, requests } = wire(() => listing([row()]));
  const { item } = await adapter.resolveLink(link, ctx);
  expect(item).toMatchObject({ item_id: wholeItemId, skuId });
  expectNoMarkers(item, [urlDigits]);
  expect(requests).toEqual([expect.objectContaining({ keyword: link, sceneId: 1 })]);
});

it.each(mainSiteMisses)(
  '[AC-B1-04zc#57] 主站链接 %s 遇%s → link_unrecognized，不从链接抽 skuId 猜',
  async (link, _name, answer) => {
    const { adapter, requests, transport } = wire(answer);
    const error = await unionFailure(() => adapter.resolveLink(link, ctx), 'link_unrecognized');
    expect(error.message).not.toContain(urlDigits);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ keyword: link, sceneId: 1 });
    expect(sent(transport).url).toBe(endpoint.baseUrl);
  },
);

it('[AC-B1-04zc#58] sku 模式的 keyword 路径：item_id 取响应的 skuId', async () => {
  const { adapter } = wire(() => listing([row()]), mode('sku'));
  const { item } = await adapter.resolveLink(unionLink, ctx);
  expect(item).toMatchObject({ platform: 'jd', item_id: skuId, skuId });
});

it.each(skuLessCases)(
  '[AC-B1-04zc#91] sku 模式下 %s 遇%s → link_unrecognized，不把 itemId 当 skuId',
  async (link, _name, answer) => {
    const { adapter, requests } = wire(answer, mode('sku'));
    const error = await unionFailure(() => adapter.resolveLink(link, ctx), 'link_unrecognized');
    expect(error.message).not.toContain(wholeItemId);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ keyword: link, sceneId: 1 });
  },
);

it('[AC-B1-04zc#59] 取第一条：第一条价格异常也不换成第二条（链接认的是商品，不是出卡）', async () => {
  const rows = [withPrice(num('39.905')), row({ itemId: otherItemId, skuId: num(otherSkuId) })];
  const { adapter } = wire(() => listing(rows));
  const { item } = await adapter.resolveLink(unionLink, ctx);
  expect(item).toMatchObject({ platform: 'jd', item_id: wholeItemId });
});

it('[AC-B1-04zc#60] 第一条没有商品标识：拒绝，不从链接补', async () => {
  const { adapter } = wire(() => listing([row({ itemId: undefined })]));
  const link = `https://item.jd.com/${urlDigits}.html`;
  await expect(adapter.resolveLink(link, ctx)).rejects.toMatchObject({
    platform: 'jd',
    code: expect.stringMatching(/^(invalid_dto|link_unrecognized)$/),
  });
});
