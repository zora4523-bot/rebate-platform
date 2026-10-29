// B1-28h: hot list cards have the shape of a search card (ProductCard) and only register a link
// with its quote snapshot, never convert (BR-PRICE-12); the union material of a whitelisted
// channel is not an ad slot, so ad_label is null (BR-TEXT-17).
import { expect, it } from 'vitest';
import { TB_CHANNEL, assertSchema, candidate, fixture } from './kit.ts';

it('[AC-B1-28h#16] 每张下发的卡登记一次链接（带该条的商品引用、联盟数据与报价），link_id 即登记结果；ProductCard 形状，ad_label=null', async () => {
  const f = fixture();
  const channelOrder = [
    candidate('card-a', { finalFen: 2990n, couponFen: 1000n, salesText: '10万+' }),
    candidate('card-b', { finalFen: 4500n }),
    candidate('card-c', { finalFen: 120n, salesText: '3件' }),
  ];
  f.setPage('taobao', TB_CHANNEL, null, 1, channelOrder);

  const data = await f.run();

  expect(f.register).toHaveBeenCalledTimes(channelOrder.length);
  const linkIds = await Promise.all(
    f.register.mock.results.map(async (result) => (await result.value).linkId as string),
  );
  expect(data.items.map((item) => item.product_card.link_id)).toEqual(linkIds);
  f.register.mock.calls.forEach(([input], index) => {
    const source = channelOrder[index]!;
    expect(input.ref).toMatchObject({
      appId: source.ref.appId,
      platform: source.ref.platform,
      productKey: source.ref.productKey,
      rawItemId: source.ref.rawItemId,
    });
    expect(input.item).toMatchObject({
      title: source.item.title,
      final_price_fen: source.item.final_price_fen,
      coupon_fen: source.item.coupon_fen,
    });
    expect(input.quote.rebateMaxFen).toBe(20n);
  });
  for (const item of data.items) {
    expect(item.product_card.ad_label ?? null).toBeNull();
    await assertSchema(item.product_card, 'ProductCard');
  }
  expect(data.items.map((item) => item.product_card.final_price_fen)).toEqual([2990, 4500, 120]);
});

it('[AC-B1-28h#17] 卡片经 catalog 的单一卡片入口按检索场景组装（同搜索卡），每条频道商品各组装一次', async () => {
  const f = fixture();
  f.setPage('taobao', TB_CHANNEL, null, 1, [candidate('entry-a'), candidate('entry-b')]);

  await f.run();

  expect(f.assemble.mock.calls.map(([input]) => [input.item.title, input.scene])).toEqual([
    ['synthetic-entry-a', 'retrieval'],
    ['synthetic-entry-b', 'retrieval'],
  ]);
});
