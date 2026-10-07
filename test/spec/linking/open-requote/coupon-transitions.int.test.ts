import { createTestDatabase } from '@couli/db/testing';
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

const database = databaseFixture(createTestDatabase);

it('[AC-B1-06k#41] D33：无原券的卡新增券且券后价未变，换快照但不误报 coupon_gone', async () => {
  const db = database();
  const f = fixture(db);
  const original = await source(f);
  reprice(f, 2990n, {
    price_fen: 3090n,
    coupon_fen: 100n,
    coupon_ids: 'synthetic-new-coupon',
  });

  const result = success(await service(f).open(f.request(original.link_id)));

  expect(result).toMatchObject({
    old_final_price_fen: '2990',
    new_final_price_fen: '2990',
    availability: 'ok',
    price_changed: false,
    new_link_id: expect.any(String),
  });
  expect(result.new_link_id).not.toBe(original.link_id);
  expect(await stored(db, result.new_link_id!)).toMatchObject({
    quoted_final_price_fen: 2990n,
    quoted_coupon_fen: 100n,
    quoted_coupon_id: 'synthetic-new-coupon',
  });
  expect(await stored(db, original.link_id)).toEqual(original);
});

it('[AC-B1-06k#42] D33：券失效结论在单飞窗口后重新判定，不沿用上次可购买状态', async () => {
  const f = fixture(database());
  const original = await source(f, 2990n, {
    price_fen: 3090n,
    coupon_fen: 100n,
    coupon_ids: 'synthetic-original-coupon',
  });
  const s = service(f);
  expect(success(await s.open(f.request(original.link_id))).availability).toBe('ok');

  f.clock.advanceMs(3001);
  reprice(f, 2990n, {
    price_fen: 3090n,
    coupon_fen: 100n,
    coupon_ids: 'synthetic-replacement-coupon',
  });
  const changed = success(await s.open(f.request(original.link_id)));

  expect(changed).toMatchObject({
    availability: 'coupon_gone',
    old_final_price_fen: '2990',
    new_final_price_fen: '2990',
    new_link_id: expect.any(String),
  });
  expect(changed.new_link_id).not.toBe(original.link_id);
  expect(f.fetch).toHaveBeenCalledTimes(2);
});

it('[AC-B1-06k#43] BR-PRICE-14：上次成功且缓存尚新，下次复核下架仍禁止外跳', async () => {
  const db = database();
  const f = fixture(db);
  const original = await source(f);
  const s = service(f);
  const first = success(await s.open(f.request(original.link_id)));
  await f.cache.put(cacheKey(original), {
    jump: jump('synthetic-live-cache'),
    fetchedAt: f.clock.now().toISOString(),
  });

  f.clock.advanceMs(3001);
  f.state.price = { kind: 'off_shelf' };
  const offShelf = await s.open(f.request(original.link_id));

  expect(offShelf).toEqual({ code: 30141, data: null });
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.convert).toHaveBeenCalledTimes(1);
  expect(await attempts(db, original.link_id)).toEqual([
    expect.objectContaining({ attempt_id: first.attempt_id }),
  ]);
  expect(await openLogs(db, original.link_id)).toEqual([
    expect.objectContaining({ result_code: 0 }),
    expect.objectContaining({ result_code: 30141 }),
  ]);
});
