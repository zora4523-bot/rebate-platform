import { expect, it } from 'vitest';
import { createParsing } from '../../../../apps/api/src/modules/parsing/index.ts';
import { cards, CTX, fixture, item, observed, TPWD, URL_A, URL_B, URL_C } from './kit.ts';

it('[AC-B1-07a-DISABLED-LIMIT] 关闭口令解析仍按原文前三个候选截断', async () => {
  const f = fixture();
  f.config.set('parse.tpwd.enabled', false);
  const result = await observed(() => f.run(`${TPWD} ${URL_A} ${URL_B} ${URL_C}`));
  expect(result).toMatchObject({
    outcome: 'returned',
    value: [
      { kind: 'error', error_code: 30132 },
      { kind: 'card', card: { product_key: 'tb:a' } },
      { kind: 'card', card: { product_key: 'jd:i_b' } },
    ],
  });
  expect(f.resolveLink.mock.calls.map(([raw]) => raw)).toEqual([URL_A, URL_B]);
  expect(f.register).toHaveBeenCalledTimes(2);
});

it('[AC-B1-07a-UNSUPPORTED-LIMIT] 不支持的平台占候选名额，不补取第四个', async () => {
  const f = fixture();
  const unsupported = 'https://vip.example.test/item/synthetic';
  const result = await observed(() => f.run(`${unsupported} ${URL_A} ${URL_B} ${URL_C}`));
  expect(result).toMatchObject({
    outcome: 'returned',
    value: [
      { kind: 'error', error_code: 30131 },
      { kind: 'card', card: { product_key: 'tb:a' } },
      { kind: 'card', card: { product_key: 'jd:i_b' } },
    ],
  });
  expect(f.resolveLink.mock.calls.map(([raw]) => raw)).not.toContain(URL_C);
  expect(f.register).toHaveBeenCalledTimes(2);
});

it('[AC-B1-07a-ALL-DUPLICATE-LIMIT] 前三条同商品只登记一次，第四条不同商品不处理', async () => {
  const f = fixture();
  const second = 'https://tb.example.test/item/synthetic-second';
  const third = 'https://tb.example.test/item/synthetic-third';
  f.refs.set(second, { platform: 'taobao', item_id: 'synthetic-second-a' });
  f.refs.set(third, { platform: 'taobao', item_id: 'synthetic-third-a' });
  const result = await observed(() => f.run(`${URL_A} ${second} ${third} ${URL_B}`));
  expect(result).toMatchObject({
    outcome: 'returned',
    value: [{ kind: 'card', card: { product_key: 'tb:a' } }],
  });
  expect(f.resolveLink.mock.calls.map(([raw]) => raw)).not.toContain(URL_B);
  expect(f.assemble).toHaveBeenCalledTimes(1);
  expect(f.register).toHaveBeenCalledTimes(1);
});

it('[AC-B1-07a-RAW-QUERY] 候选保留查询串原文，URL内嵌网址不成为额外候选', async () => {
  const f = fixture();
  const raw =
    'https://tb.example.test/item/synthetic?next=https://jd.example.test/item/b&value=a%2Fb&x=1&x=2';
  f.refs.set(raw, { platform: 'taobao', item_id: 'synthetic-a' });
  const result = await observed(() => f.run(`合成分享文案【${raw}】\n${URL_C}`));
  expect(result).toMatchObject({
    outcome: 'returned',
    value: [
      { kind: 'card', hit: { platform: 'taobao', kind: 'url', raw } },
      { kind: 'card', hit: { platform: 'pdd', kind: 'url', raw: URL_C } },
    ],
  });
  expect(f.resolveLink.mock.calls.map(([input]) => input)).toEqual([raw, URL_C]);
  expect(f.register).toHaveBeenCalledTimes(2);
});

it('[AC-B1-07a-JD-CONFIG-REFRESH] 同一服务下一请求按更新后的全局京东模式派生', async () => {
  const f = fixture();
  const result = await observed(async () => {
    const service = createParsing(f.options);
    const first = await service.parseInput(URL_B, CTX);
    f.config.set('product_key.jd.mode', 'sku');
    const second = await service.parseInput(URL_B, CTX);
    return [first, second].map((batch) => cards(batch).map((card) => card.product_key));
  });
  expect(result).toEqual({ outcome: 'returned', value: [['jd:i_b'], ['jd:sku-b']] });
  expect(f.configValue).toHaveBeenCalledWith(CTX.appId, 'product_key.jd.mode');
});

it.each([
  ['jd', URL_B, 'jd:i_b'],
  ['pdd', URL_C, 'pdd:c'],
] as const)(
  '[AC-B1-07a-PLATFORM-PRICE-STATE] %s价格恒等式异常走主动查询的带类型结果',
  async (platform, url, productKey) => {
    const f = fixture();
    // All fields remain positive; a one-fen mismatch must still fail closed.
    f.getItem.mockImplementation(async (ref) => item(ref, { final_price_fen: 9999n }));
    const result = await observed(() => f.run(url));
    expect(result).toEqual({
      outcome: 'returned',
      value: [{ kind: 'price_unavailable', hit: { platform, kind: 'url', raw: url }, productKey }],
    });
    expect(f.assemble).toHaveBeenCalledWith(
      expect.objectContaining({ scene: 'active_query', entrySource: 'parse' }),
    );
    expect(f.register).not.toHaveBeenCalled();
    expect(f.quote).not.toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();
  },
);

it('[AC-B1-07a-PRICE-STATE-RECOVERY] 价格恢复后同一服务可重新出卡，不沿用异常结果', async () => {
  const f = fixture();
  f.getItem.mockImplementationOnce(async (ref) => item(ref, { price_status: 'anomaly' }));
  const result = await observed(async () => {
    const service = createParsing(f.options);
    return [await service.parseInput(URL_A, CTX), await service.parseInput(URL_A, CTX)];
  });
  expect(result).toMatchObject({
    outcome: 'returned',
    value: [
      [{ kind: 'price_unavailable', productKey: 'tb:a' }],
      [{ kind: 'card', card: { product_key: 'tb:a', final_price_fen: 10000 } }],
    ],
  });
  expect(f.register).toHaveBeenCalledTimes(1);
});

it('[AC-B1-07a-TPWD-NO-REBATE] 无返利口令也出卡，口令不进入打开目标', async () => {
  const f = fixture();
  f.quote.mockResolvedValue({
    rebateMinFen: 0n,
    rebateMaxFen: 0n,
    estNetPriceFen: null,
    rebateBasis: 'no_rebate',
  });
  const result = await observed(() => f.run(TPWD));
  expect(result).toMatchObject({
    outcome: 'returned',
    value: [
      {
        kind: 'card',
        hit: { platform: 'taobao', kind: 'tpwd', raw: TPWD },
        card: { rebate_basis: 'no_rebate', cta: { text_key: 'btn.buy.no_rebate' } },
      },
    ],
  });
  if (result.outcome === 'returned')
    expect(JSON.stringify(cards(result.value))).not.toContain(TPWD);
  expect(f.register.mock.calls[0]?.[0].ref.canonicalUrl ?? '').not.toContain(TPWD);
  expect(f.convert).not.toHaveBeenCalled();
});
