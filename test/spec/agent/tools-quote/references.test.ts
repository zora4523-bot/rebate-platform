import { expect, it } from 'vitest';
import { createRebateQuoteHandler } from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import { context, fixture, productKey, productOf } from './kit.ts';

it('[AC-B3-04c#5][BR-AI-05] 情境 product_key 一致时重新从 catalog 取数', async () => {
  const f = fixture();
  const handler = createRebateQuoteHandler(f.deps);
  const ctx = context({ context: { product_key: productKey } });
  const outcome = await handler.run({ product_key: productKey }, ctx);
  expect(outcome.kind).toBe('ok');
  if (outcome.kind !== 'ok') return;
  expect(productOf(outcome.cards)).toMatchObject({
    product_key: productKey,
    final_price_fen: 2990,
  });
  expect(f.readProduct).toHaveBeenCalledExactlyOnceWith(productKey, ctx);
  expect(f.parseUrl).not.toHaveBeenCalled();
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.register).toHaveBeenCalledTimes(1);
});

it.each([
  ['模型修改合法键', productKey, 'jd:synthetic-other'],
  ['模型修改格式', productKey, 'not-a-key'],
  ['双方都是畸形键', 'not-a-key', 'not-a-key'],
  ['空标识', 'jd:', 'jd:'],
  ['把 URL 当作商品键', 'https://example.invalid/item', 'https://example.invalid/item'],
  ['无情境来源', undefined, productKey],
] as const)(
  '[AC-B3-04c#6][BR-AI-05] %s 必须 invalid_args，不能取数或登记',
  async (_label, trusted, proposed) => {
    const f = fixture();
    const handler = createRebateQuoteHandler(f.deps);
    const ctx = context(trusted === undefined ? {} : { context: { product_key: trusted } });
    expect(await handler.run({ product_key: proposed }, ctx)).toEqual({
      kind: 'rejected',
      modelView: { error: 'invalid_args' },
    });
    expect(f.readProduct).not.toHaveBeenCalled();
    expect(f.parseUrl).not.toHaveBeenCalled();
    expect(f.assemble).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
  },
);

it.each([{ card_id: 'c2' }, { ref_ordinal: 2 }])(
  '[AC-B3-04c#7][BR-AI-05] 本会话旧卡或最近商品列表序号 %j 由服务端解析后重新报价',
  async (reference) => {
    const f = fixture();
    const handler = createRebateQuoteHandler(f.deps);
    const ctx = context();
    const outcome = await handler.run(reference, ctx);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(productOf(outcome.cards)).toMatchObject({ product_key: productKey });
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith(reference, ctx);
    expect(f.readProduct).toHaveBeenCalledExactlyOnceWith(productKey, ctx);
    expect(f.parseUrl).not.toHaveBeenCalled();
  },
);

it('[AC-B3-04c#8][BR-AI-05] 不存在或别的会话的 card_id 不得命中商品', async () => {
  const f = fixture();
  const handler = createRebateQuoteHandler(f.deps);
  f.resolve.mockResolvedValue({ kind: 'invalid_args' });
  const ctx = context({ sessionId: 'synthetic-other-session' });
  expect(await handler.run({ card_id: 'c2' }, ctx)).toEqual({
    kind: 'rejected',
    modelView: { error: 'invalid_args' },
  });
  expect(f.resolve).toHaveBeenCalledExactlyOnceWith({ card_id: 'c2' }, ctx);
  expect(f.readProduct).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

it('[AC-B3-04c#9][BR-AI-05] 序号超过最近商品列表时保留 clarify 语义，不回退到其他商品', async () => {
  const f = fixture();
  const handler = createRebateQuoteHandler(f.deps);
  f.resolve.mockResolvedValue({ kind: 'clarify' });
  const outcome = await handler.run({ ref_ordinal: 99 }, context());
  expect(outcome.modelView).toEqual({ error: 'clarify' });
  expect(outcome.kind === 'ok' ? outcome.cards : []).toEqual([]);
  expect(f.readProduct).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

it.each([
  {},
  { url: 'https://example.invalid/invented' },
  { item_id: 'synthetic-invented' },
  { card_id: 'c2', product_key: productKey },
  { card_id: 'c2', ref_ordinal: 1 },
  { card_id: 'c2', price_fen: 1 },
  { ref_ordinal: 0 },
  { ref_ordinal: 1.5 },
  { ref_ordinal: '1' },
])('[AC-B3-04c#10][BR-AI-05] 拒绝无来源、歧义和模型补充字段 %j', async (args) => {
  const f = fixture();
  const handler = createRebateQuoteHandler(f.deps);
  expect(await handler.run(args, context({ context: { product_key: productKey } }))).toEqual({
    kind: 'rejected',
    modelView: { error: 'invalid_args' },
  });
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.readProduct).not.toHaveBeenCalled();
  expect(f.parseUrl).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
});

it('[AC-B3-04c#11][BR-AI-04][BR-AI-05] 重新查询失败不能用上一张成功卡或模型补值兜底', async () => {
  const f = fixture();
  const handler = createRebateQuoteHandler(f.deps);
  const ctx = context({ context: { product_key: productKey } });
  expect((await handler.run({ product_key: productKey }, ctx)).kind).toBe('ok');
  f.readProduct.mockRejectedValue(new Error('合成查询失败'));
  const outcome = await handler.run({ product_key: productKey }, ctx);
  expect(outcome.kind).toBe('failed');
  expect(outcome).not.toHaveProperty('cards');
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(outcome.modelView)).not.toContain('2990');
  expect(JSON.stringify(outcome.modelView)).not.toContain('合成查询失败');
});
