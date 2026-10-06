// price_unavailable 卡的 link_id 形状待契约同步（BR-PRICE-01 与 ProductCard.link_id 必填冲突），由后续契约任务与 B1-07a 覆盖。
// BR-PRICE-07 has no public entry_source enum. These names are the module's input convention.
// Sharing landing pages/posters are not ProductCard displays; their amount suppression is outside this task.
import { expect, it } from 'vitest';
import { fen, fixture, request, viewer } from './kit.ts';

it.each([
  { source: 'parse', basis: 'price_compare_risk' },
  { source: 'search', basis: 'price_compare_risk' },
  { source: 'agent', basis: 'price_compare_risk' },
  { source: 'agent_refresh', basis: 'price_compare_risk' },
  { source: 'feed', basis: 'normal' },
  { source: 'pool', basis: 'normal' },
  { source: 'tlj_pool', basis: 'normal' },
  { source: 'detail', basis: 'price_compare_risk' },
  { source: 'watch', basis: 'price_compare_risk' },
  { source: null, basis: 'price_compare_risk' },
  { source: 'unknown_source', basis: 'price_compare_risk' },
])(
  '[AC-B1-05f#12] BR-PRICE-07：淘宝无预判结果，$source 按 $basis 报价',
  async ({ source, basis }) => {
    const f = fixture();
    const input = request({ entrySource: source });
    const card = await f.service.assemble(input);
    expect(f.quoted).toHaveBeenCalledExactlyOnceWith(input.item, viewer(), {
      buyType: 'self',
      entrySource: source,
      rebateBasis: basis,
    });
    expect(card.rebate_basis).toBe(basis);
    expect(fen(card.rebate_max_fen)).toBe(433n);
    expect(fen(card.rebate_min_fen)).toBe(basis === 'normal' ? 433n : 211n);
    expect(f.entrySource).not.toHaveBeenCalled();
  },
);

it.each([
  { origin: 'pool', basis: 'normal' },
  { origin: 'feed', basis: 'normal' },
  { origin: 'tlj_pool', basis: 'normal' },
  { origin: 'share_panel', basis: 'normal' },
  { origin: 'share_landing', basis: 'normal' },
  { origin: 'search', basis: 'price_compare_risk' },
  { origin: 'parse', basis: 'price_compare_risk' },
  { origin: 'agent', basis: 'price_compare_risk' },
  { origin: null, basis: 'price_compare_risk' },
])(
  '[AC-B1-05f#13] BR-PRICE-07：详情、提醒和派生请求继承服务端来源 $origin',
  async ({ origin, basis }) => {
    for (const entrySource of ['detail', 'watch', 'rebate_quote']) {
      const f = fixture();
      f.entrySource.mockResolvedValue(origin);
      const input = request({ entrySource, sourceLinkId: 'source-link' });
      const card = await f.service.assemble(input);
      expect(f.entrySource).toHaveBeenCalledExactlyOnceWith('card-app-a', 'source-link');
      expect(f.quoted).toHaveBeenCalledExactlyOnceWith(input.item, viewer(), {
        buyType: 'self',
        entrySource: origin,
        rebateBasis: basis,
      });
      expect(f.register).toHaveBeenCalledWith(expect.objectContaining({ entrySource: origin }));
      expect(card.rebate_basis).toBe(basis);
    }
  },
);

it('[AC-B1-05f#14] BR-PRICE-11：同商品换来源必须重新报价，不复用前次区间', async () => {
  const f = fixture();
  const input = request();
  const risk = await f.service.assemble(input);
  const normal = await f.service.assemble({ ...input, entrySource: 'pool' });
  expect(risk.rebate_basis).toBe('price_compare_risk');
  expect(normal.rebate_basis).toBe('normal');
  expect(fen(risk.rebate_min_fen)).toBe(211n);
  expect(fen(normal.rebate_min_fen)).toBe(433n);
  expect(risk.disclaimer_keys).toContain('rebate_compare');
  expect(normal.disclaimer_keys).not.toContain('rebate_compare');
  expect(f.quoted).toHaveBeenCalledTimes(2);
});

it('[AC-B1-05f#15] 来源读取按服务端应用隔离，读不到时不推测正常返利', async () => {
  const f = fixture();
  f.current.mockResolvedValue(viewer({ appId: 'card-app-b' }));
  const input = request({
    entrySource: 'detail',
    sourceLinkId: 'foreign-link',
    ref: { ...request().ref, appId: 'card-app-b' },
  });
  const card = await f.service.assemble(input);
  expect(f.entrySource).toHaveBeenCalledExactlyOnceWith('card-app-b', 'foreign-link');
  expect(card.rebate_basis).toBe('price_compare_risk');
  expect(f.register).toHaveBeenCalledWith(
    expect.objectContaining({
      viewer: viewer({ appId: 'card-app-b' }),
      entrySource: null,
    }),
  );
});
