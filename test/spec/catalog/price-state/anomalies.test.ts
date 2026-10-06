import { expect, it } from 'vitest';
import { ANOMALIES, fixture, input, item, observed, PLATFORMS } from './kit.ts';

it.each(PLATFORMS.flatMap((platform) => ANOMALIES.map((example) => ({ platform, ...example }))))(
  '[AC-B1-05i#1] BR-PRICE-01：$platform / $name 在两类入口都记录告警且不产生金额或 link',
  async ({ platform, value }) => {
    for (const scene of ['retrieval', 'active_query'] as const) {
      const f = fixture();
      const request = input({ ...value, platform }, scene);
      const result = await observed(() => f.service.assemble(request));
      expect(result).toEqual({
        outcome: 'returned',
        value: { kind: scene === 'retrieval' ? 'skipped' : 'price_unavailable' },
      });
      expect(f.register).not.toHaveBeenCalled();
      expect(f.quote).not.toHaveBeenCalled();
      expect(f.issue).not.toHaveBeenCalled();
      expect(f.warn).toHaveBeenCalledTimes(1);
      expect(f.warn.mock.calls[0]?.[0]).toMatchObject({ code: 'PRICE_ANOMALY' });
    }
  },
);

it.each(['search', 'feed', 'agent'])(
  '[AC-B1-05i#2] BR-PRICE-01：$0 混排页跳过中间异常商品，前后正常卡仍可下发',
  async (entrySource) => {
    const f = fixture();
    const requests = [
      input(item({ item_id: 'synthetic-before' }), 'retrieval', entrySource),
      input(item({ item_id: 'synthetic-bad', price_status: 'anomaly' }), 'retrieval', entrySource),
      input(
        item({ item_id: 'synthetic-after', coupon_fen: 0n, final_price_fen: 12000n }),
        'retrieval',
        entrySource,
      ),
    ];
    // A rejection from any one item rejects the caller's whole page; no test-side catch/filter.
    const page = await observed(() => Promise.all(requests.map((r) => f.service.assemble(r))));
    expect(page).toEqual({
      outcome: 'returned',
      value: [
        { kind: 'card', card: expect.objectContaining({ product_key: 'tb:synthetic-before' }) },
        { kind: 'skipped' },
        { kind: 'card', card: expect.objectContaining({ product_key: 'tb:synthetic-after' }) },
      ],
    });
    expect(f.register).toHaveBeenCalledTimes(2);
    expect(f.register.mock.calls.map(([r]) => r.ref.productKey).sort()).toEqual([
      'tb:synthetic-after',
      'tb:synthetic-before',
    ]);
    expect(f.warn).toHaveBeenCalledTimes(1);
    expect(f.warn.mock.calls[0]?.[0]).toMatchObject({ code: 'PRICE_ANOMALY' });
  },
);

it.each(['detail', 'parse', 'rebate_quote', 'open'])(
  '[AC-B1-05i#3] BR-PRICE-01/12：$0 主动查询失败即关，继承检索来源也不变成 skipped',
  async (entrySource) => {
    const f = fixture();
    const request = {
      ...input(item({ price_status: 'anomaly' }), 'active_query', entrySource),
      sourceLinkId: 'synthetic-source-link',
    };
    f.entrySource.mockResolvedValue('search');
    const result = await observed(() => f.service.assemble(request));
    // Exact internal result excludes card, link_id, item_ref and every amount, including zero.
    expect(result).toEqual({ outcome: 'returned', value: { kind: 'price_unavailable' } });
    expect(f.register).not.toHaveBeenCalled();
    expect(f.warn).toHaveBeenCalledTimes(1);
    expect(f.warn.mock.calls[0]?.[0]).toMatchObject({ code: 'PRICE_ANOMALY' });
  },
);

it('[AC-B1-05i#4] BR-PRICE-01：同一商品的检索与主动查询并发时结果不串用', async () => {
  const f = fixture();
  const bad = item({ final_price_fen: 10001n });
  const result = await observed(() =>
    Promise.all([
      f.service.assemble(input(bad, 'retrieval', 'search')),
      f.service.assemble(input(bad, 'active_query', 'search')),
    ]),
  );
  expect(result).toEqual({
    outcome: 'returned',
    value: [{ kind: 'skipped' }, { kind: 'price_unavailable' }],
  });
  expect(f.register).not.toHaveBeenCalled();
  expect(f.warn).toHaveBeenCalledTimes(2);
  for (const call of f.warn.mock.calls) expect(call[0]).toMatchObject({ code: 'PRICE_ANOMALY' });
});
