import { expect, it } from 'vitest';
import {
  attempts,
  cacheKey,
  databaseFixture,
  fixture,
  jump,
  openLogs,
  reprice,
  service,
  source,
  stored,
  success,
} from './kit.ts';

const database = databaseFixture();

it('[AC-B1-06k#9] BR-PRICE-14：下架优先于缓存、券失效及价格变化，30141 且无 jump/attempt', async () => {
  const db = database();
  const f = fixture(db);
  const original = await source(f, 2990n, {
    price_fen: 3090n,
    coupon_fen: 100n,
    coupon_ids: 'synthetic-old-coupon',
  });
  await f.cache.put(cacheKey(original), { jump: jump(), fetchedAt: f.clock.now().toISOString() });
  f.state.price = { kind: 'off_shelf' };
  const result = await service(f).open(f.request(original.link_id));
  expect(result).toMatchObject({ code: 30141, data: null });
  expect(f.convert).not.toHaveBeenCalled();
  expect(await attempts(db, original.link_id)).toEqual([]);
  expect(await openLogs(db, original.link_id)).toEqual([
    expect.objectContaining({ result_code: 30141, event: 'open' }),
  ]);
});

it.each([
  ['synthetic-a,synthetic-z', 'synthetic-z', 100n, 2990n, 'coupon_gone'],
  ['synthetic-a', 'synthetic-b', 100n, 2990n, 'coupon_gone'],
  ['synthetic-a', '', 0n, 3000n, 'coupon_gone'],
  ['synthetic-a', 'synthetic-b', 50n, 3040n, 'coupon_gone'],
  ['synthetic-a', 'synthetic-b', 100n, 3190n, 'coupon_gone'],
  ['synthetic-a', 'synthetic-a,synthetic-b', 100n, 2990n, 'ok'],
  ['synthetic-a', 'synthetic-a', 150n, 2990n, 'ok'],
] as const)(
  '[AC-B1-06k#10] D33：原券 %s → %s，当前券额 %s、价 %s，状态 %s；券快照变化也换 link',
  async (oldIds, newIds, coupon, next, availability) => {
    const db = database();
    const f = fixture(db);
    const original = await source(f, 2990n, {
      price_fen: 3090n,
      coupon_fen: 100n,
      coupon_ids: oldIds,
    });
    reprice(f, next, { price_fen: next + coupon, coupon_fen: coupon, coupon_ids: newIds });
    const result = success(await service(f).open(f.request(original.link_id)));
    expect(result.availability).toBe(availability);
    expect(result.new_final_price_fen).toBe(next.toString());
    expect(result.new_link_id).toEqual(expect.any(String));
    expect(result.new_link_id).not.toBe(original.link_id);
    const replacement = await stored(db, result.new_link_id!);
    expect(replacement).toMatchObject({
      quoted_final_price_fen: next,
      quoted_coupon_fen: coupon,
      quoted_coupon_id: newIds === '' ? null : newIds,
    });
    expect(await stored(db, original.link_id)).toEqual(original);
    // Confirm/cancel both replace the card: opening that replacement must not warn again.
    const again = success(await service(f).open(f.request(replacement.link_id)));
    expect(again.availability).toBe('ok');
  },
);

it('[AC-B1-06k#11] BR-PRICE-14：券失效同时返利归零，下发 coupon_gone 和零返利供同一弹窗展示', async () => {
  const f = fixture(database());
  const original = await source(f, 2990n, {
    price_fen: 3090n,
    coupon_fen: 100n,
    coupon_ids: 'synthetic-a',
  });
  reprice(f, 3090n);
  f.quote.mockResolvedValue({
    rebateMinFen: 0n,
    rebateMaxFen: 0n,
    rebateBasis: 'no_rebate',
    estNetPriceFen: null,
  });
  const result = success(await service(f).open(f.request(original.link_id)));
  expect(result).toMatchObject({
    availability: 'coupon_gone',
    new_rebate_min_fen: '0',
    new_rebate_max_fen: '0',
  });
  expect(result.jump).toEqual(jump());
});

it.each([
  'zero_anomaly',
  'expired_coupon_anomaly',
  'invalid_identity',
  'catalog_unavailable',
] as const)('[AC-B1-06k#12] D33：%s 进入复核失败，不把零价当降价、不按无券重算', async (kind) => {
  const db = database();
  const f = fixture(db);
  const original = await source(f, 2990n, {
    price_fen: 3090n,
    coupon_fen: 100n,
    coupon_ids: 'synthetic-expired',
  });
  if (kind === 'catalog_unavailable') {
    f.assemble.mockResolvedValue({ kind: 'price_unavailable' });
  } else if (kind === 'invalid_identity') {
    reprice(f, 2990n, { price_fen: 3100n, coupon_fen: 100n });
  } else {
    // Union already normalizes an expired coupon still counted by the platform to anomaly.
    reprice(f, 0n, {
      price_status: 'anomaly',
      price_anomaly_reason: kind === 'expired_coupon_anomaly' ? 'expired_item' : 'invalid_price',
    });
  }
  const result = await service(f).open(f.request(original.link_id));
  expect(result).toMatchObject({ code: 50303, data: null });
  expect(f.convert).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  expect(await stored(db, original.link_id)).toEqual(original);
  expect(await attempts(db, original.link_id)).toEqual([]);
  expect(await openLogs(db, original.link_id)).toEqual([
    expect.objectContaining({ result_code: 50303 }),
  ]);
});

it('[AC-B1-06k#32] BR-PRICE-14：淘礼金已领完返回 30602，不返回废弃的 30142、不生成外跳', async () => {
  const db = database();
  const f = fixture(db);
  f.config.set('tlj.enabled', true);
  const original = await source(f, 2990n, {}, { scene: 'taolijin' });
  f.state.price = { kind: 'tlj_empty' };
  const result = await service(f).open(f.request(original.link_id));
  expect(result).toEqual({ code: 30602, data: null });
  expect(f.convert).not.toHaveBeenCalled();
  expect(await attempts(db, original.link_id)).toEqual([]);
  expect(await openLogs(db, original.link_id)).toEqual([
    expect.objectContaining({ result_code: 30602 }),
  ]);
});
