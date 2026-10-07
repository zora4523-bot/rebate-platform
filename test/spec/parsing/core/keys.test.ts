import { expect, it } from 'vitest';
import { createParsing, parseUrl } from '../../../../apps/api/src/modules/parsing/index.ts';
import type { ItemRef } from '../../../../apps/api/src/modules/union/index.ts';
import { cards, CTX, fixture, observed, TPWD, URL_A, URL_B, URL_C } from './kit.ts';

it.each([
  [
    '淘宝多段原串',
    URL_A,
    { platform: 'taobao', item_id: 'synthetic-prefix-001' },
    'item',
    'tb:001',
  ],
  ['淘宝无分隔原串', URL_A, { platform: 'taobao', item_id: '001' }, 'item', 'tb:001'],
  [
    '京东全局item模式',
    URL_B,
    { platform: 'jd', itemId: 'synthetic_002_tail', skuId: '003' },
    'item',
    'jd:i_002',
  ],
  [
    '京东全局sku模式',
    URL_B,
    { platform: 'jd', itemId: 'synthetic_002_tail', skuId: '003' },
    'sku',
    'jd:003',
  ],
  [
    '拼多多goods_id而非goods_sign',
    URL_C,
    { platform: 'pdd', goods_id: '004', goods_sign: 'synthetic-plan' },
    'item',
    'pdd:004',
  ],
] satisfies readonly [string, string, ItemRef, string, string][])(
  '[AC-B1-07a-KEY] %s',
  async (_name, url, ref, mode, key) => {
    const f = fixture();
    f.refs.set(url, ref);
    f.config.set('product_key.jd.mode', mode);
    const results = await f.run(url);
    expect(cards(results).map((card) => card.product_key)).toEqual([key]);
    expect(f.assemble).toHaveBeenCalledWith(
      expect.objectContaining({ ref: expect.objectContaining({ productKey: key }) }),
    );
  },
);

it.each([
  ['淘宝空末段', URL_A, { platform: 'taobao', item_id: 'synthetic-' }],
  ['淘宝空串', URL_A, { platform: 'taobao', item_id: '' }],
  ['非法斜线', URL_A, { platform: 'taobao', item_id: 'synthetic-a/b' }],
  ['非法问号', URL_A, { platform: 'taobao', item_id: 'synthetic-a?b' }],
  ['非法井号', URL_A, { platform: 'taobao', item_id: 'synthetic-a#b' }],
  ['空格不得trim', URL_A, { platform: 'taobao', item_id: 'synthetic- a' }],
  ['过长不得截断', URL_A, { platform: 'taobao', item_id: 'a'.repeat(125) }],
  ['京东item缺失不切sku', URL_B, { platform: 'jd', skuId: 'synthetic-sku' }],
  ['京东第二段为空', URL_B, { platform: 'jd', itemId: 'synthetic__tail', skuId: 'synthetic-sku' }],
  ['拼多多仅有签名', URL_C, { platform: 'pdd', goods_sign: 'synthetic-plan' }],
] satisfies readonly [string, string, ItemRef][])(
  '[AC-B1-07a-UNDERIVABLE] 已识别商品派生失败30131：%s',
  async (_name, url, ref) => {
    const f = fixture();
    f.refs.set(url, ref);
    expect(await f.run(url)).toEqual([
      { kind: 'error', hit: { platform: ref.platform, kind: 'url', raw: url }, error_code: 30131 },
    ]);
    expect(f.assemble).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
  },
);

it('[AC-B1-07a-TPWD-KEY] 口令已识别到商品但键无法派生是30131', async () => {
  const f = fixture();
  f.refs.set(TPWD, { platform: 'taobao', item_id: 'synthetic-' });
  expect(await f.run(TPWD)).toEqual([
    { kind: 'error', hit: { platform: 'taobao', kind: 'tpwd', raw: TPWD }, error_code: 30131 },
  ]);
  expect(f.register).not.toHaveBeenCalled();
});

it('[AC-B1-07a-JD-SKU] sku模式缺失sku不按当前响应切回item', async () => {
  const f = fixture();
  f.config.set('product_key.jd.mode', 'sku');
  f.refs.set(URL_B, { platform: 'jd', itemId: 'synthetic_b_tail' });
  expect(await f.run(URL_B)).toEqual([
    { kind: 'error', hit: { platform: 'jd', kind: 'url', raw: URL_B }, error_code: 30131 },
  ]);
  expect(f.register).not.toHaveBeenCalled();
});

it('[AC-B1-07a-JD-DEFAULT] 未配置京东模式默认item', async () => {
  const f = fixture();
  f.config.delete('product_key.jd.mode');
  expect(cards(await f.run(URL_B)).map((card) => card.product_key)).toEqual(['jd:i_b']);
});

it('[AC-B1-07a-PROMO-KEY] 合成推广短链以联盟识别的商品派生key，不取URL路径', async () => {
  const f = fixture();
  const url = 'https://promo.example.test/s/synthetic-short';
  f.refs.set(url, { platform: 'taobao', item_id: 'synthetic-prefix-a' });
  expect(cards(await f.run(url)).map((card) => card.product_key)).toEqual(['tb:a']);
  expect(f.resolveLink).toHaveBeenCalledWith(url, expect.objectContaining(CTX));
  expect(f.getItem).toHaveBeenCalledWith(
    { platform: 'taobao', item_id: 'synthetic-prefix-a' },
    expect.objectContaining(CTX),
  );
});

it('[AC-B1-07a-URL-ID-NOT-EVIDENCE] 商品页URL带看似可用ID但联盟未识别时仍30132', async () => {
  const f = fixture();
  const url = 'https://tb.example.test/item/a?item_id=synthetic-a';
  expect(await f.run(url)).toEqual([
    { kind: 'error', hit: { platform: 'taobao', kind: 'url', raw: url }, error_code: 30132 },
  ]);
  expect(f.getItem).not.toHaveBeenCalled();
  expect(f.assemble).not.toHaveBeenCalled();
});

it('[AC-B1-07a-PREFIX] key前缀读平台字典而不是硬编码', async () => {
  const f = fixture();
  f.platforms.splice(0, 1, { ...f.platforms[0]!, key_prefix: 'tx' });
  expect(cards(await f.run(URL_A)).map((card) => card.product_key)).toEqual(['tx:a']);
});

it('[AC-B1-07a-DEDUP] 同商品不同goods_sign只出一张卡并只登记一次', async () => {
  const f = fixture();
  const other = 'https://pdd.example.test/item/other';
  f.refs.set(other, { platform: 'pdd', goods_id: 'c', goods_sign: 'synthetic-other-plan' });
  const results = await f.run(`${URL_C} ${other}`);
  expect(cards(results).map((card) => card.product_key)).toEqual(['pdd:c']);
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.assemble).toHaveBeenCalledTimes(1);
});

it('[AC-B1-07a-ALIAS] 去重使用resolveProductKey归一后的键', async () => {
  const f = fixture();
  const other = 'https://tb.example.test/item/legacy';
  f.refs.set(other, { platform: 'taobao', item_id: 'synthetic-legacy' });
  f.aliases.set('tb:legacy', 'tb:a');
  expect(cards(await f.run(`${URL_A} ${other}`))).toHaveLength(1);
  expect(f.resolveProductKey).toHaveBeenCalledWith('tb:legacy');
  expect(f.register).toHaveBeenCalledTimes(1);
});

it('[AC-B1-07a-CROSS-PLATFORM] 同stable_id跨平台仍各出一张卡', async () => {
  const f = fixture();
  f.refs.set(URL_C, { platform: 'pdd', goods_id: 'a', goods_sign: 'synthetic-plan-a' });
  expect(cards(await f.run(`${URL_A} ${URL_C}`)).map((card) => card.product_key)).toEqual([
    'tb:a',
    'pdd:a',
  ]);
});

it('[AC-B1-07a-REQUEST-SCOPE] 去重不跨消息或app泄漏，重复请求各自出卡', async () => {
  const f = fixture();
  const service = createParsing(f.options);
  const first = await service.parseInput(URL_A, CTX);
  const second = await service.parseInput(URL_A, CTX);
  f.viewer.appId = 'synthetic-other-app';
  const third = await service.parseInput(URL_A, { ...CTX, appId: f.viewer.appId });
  expect([first, second, third].map((results) => cards(results).length)).toEqual([1, 1, 1]);
  expect(f.register.mock.calls.map(([input]) => input.ref.appId)).toEqual([
    CTX.appId,
    CTX.appId,
    'synthetic-other-app',
  ]);
});

it('[AC-B1-07a-URL-PORT] 按url公开函数返回派生商品，留给B1-06i登记和转链', async () => {
  const f = fixture();
  const result = await parseUrl(f.options, URL_C, CTX);
  expect(result.ref).toMatchObject({
    appId: CTX.appId,
    platform: 'pdd',
    productKey: 'pdd:c',
    rawItemId: 'synthetic-plan-c',
  });
  expect(result.item).toMatchObject({ platform: 'pdd', goods_id: 'c', final_price_fen: 10000n });
  expect(f.resolveLink).toHaveBeenCalledWith(
    URL_C,
    expect.objectContaining({ appId: CTX.appId, signal: expect.any(AbortSignal) }),
  );
  expect(f.getItem).toHaveBeenCalledWith(
    f.refs.get(URL_C),
    expect.objectContaining({ appId: CTX.appId, signal: expect.any(AbortSignal) }),
  );
  expect(f.assemble).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
});

it.each([
  ['https://vip.example.test/item/a', 30131],
  ['https://tb.example.test/item/unresolved', 30132],
  [URL_A, 30131],
] as const)('[AC-B1-07a-URL-ERROR] 按url函数错误分界 %s → %i', async (url, code) => {
  const f = fixture();
  f.refs.set(URL_A, { platform: 'taobao', item_id: 'synthetic-' });
  expect(await observed(() => parseUrl(f.options, url, CTX))).toMatchObject({
    outcome: 'rejected',
    error: { code },
  });
  expect(f.register).not.toHaveBeenCalled();
});
