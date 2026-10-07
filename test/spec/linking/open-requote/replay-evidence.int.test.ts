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
  unknownPricePddLink,
} from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
] as const)(
  '[AC-B1-06k#37] BR-ATTR-14：复核失败时 expired=%s 与 cache_hit=%s 独立记录',
  async (expired, cacheHit) => {
    const db = database();
    const f = fixture(db);
    const original = await source(f);
    f.clock.set(new Date(original.expire_at.getTime() + (expired ? 1 : -1)));
    if (cacheHit) {
      await f.cache.put(cacheKey(original), {
        jump: jump('synthetic-fallback'),
        fetchedAt: f.clock.now().toISOString(),
      });
    }
    f.fetch.mockRejectedValue(new Error('synthetic-price-unavailable'));

    const result = await service(f).open(f.request(original.link_id));

    expect(result.code).toBe(cacheHit ? 0 : 50303);
    if (cacheHit) {
      expect(success(result)).toMatchObject({
        requote_failed: true,
        jump: jump('synthetic-fallback'),
      });
    } else {
      expect(result.data).toBeNull();
    }
    expect(await openLogs(db, original.link_id)).toEqual([
      expect.objectContaining({
        expired,
        cache_hit: cacheHit,
        result_code: cacheHit ? 0 : 50303,
        event: 'open',
      }),
    ]);
    expect(await attempts(db, original.link_id)).toHaveLength(cacheHit ? 1 : 0);
    expect(f.convert).not.toHaveBeenCalled();
  },
);

it('[AC-B1-06k#38] BR-PRICE-13：缓存降级成功后同键重放仍返回首次结果，即使缓存已超时且价格恢复', async () => {
  const db = database();
  const f = fixture(db);
  const original = await source(f);
  await f.cache.put(cacheKey(original), {
    jump: jump('synthetic-fallback'),
    fetchedAt: f.clock.now().toISOString(),
  });
  f.fetch.mockRejectedValueOnce(new Error('synthetic-price-unavailable'));
  const request = f.request(original.link_id);
  const first = success(await service(f).open(request));
  expect(first.requote_failed).toBe(true);

  f.clock.advanceMs(900001);
  reprice(f, 3190n);
  const replay = success(await service(f).open(request));

  expect(replay).toEqual(first);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.convert).not.toHaveBeenCalled();
  expect(await openLogs(db, original.link_id)).toHaveLength(1);
  expect(await attempts(db, original.link_id)).toEqual([
    expect.objectContaining({ attempt_id: first.attempt_id }),
  ]);
});

it('[AC-B1-06k#39] BR-PRICE-13/BR-ATTR-21：单飞复用涨价后的新 link，但不同幂等键各签发尝试', async () => {
  const db = database();
  const f = fixture(db);
  const original = await source(f);
  reprice(f, 3090n);
  const s = service(f);
  const first = success(await s.open(f.request(original.link_id)));
  expect(first.new_link_id).toEqual(expect.any(String));

  f.clock.advanceMs(3000);
  reprice(f, 3190n);
  const second = success(await s.open(f.request(original.link_id)));

  expect(second).toMatchObject({
    old_final_price_fen: '2990',
    new_final_price_fen: '3090',
    price_changed: true,
    new_link_id: first.new_link_id,
    jump: first.jump,
    quoted_at: first.quoted_at,
  });
  expect(second.attempt_id).not.toBe(first.attempt_id);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.convert).toHaveBeenCalledTimes(1);
  expect(await openLogs(db, original.link_id)).toEqual([]);
  expect(await openLogs(db, first.new_link_id!)).toHaveLength(2);
  const records = await attempts(db, first.new_link_id!);
  expect(records).toHaveLength(2);
  expect(records.map((record) => record.attempt_id)).toEqual(
    expect.arrayContaining([first.attempt_id, second.attempt_id]),
  );
  expect(await stored(db, original.link_id)).toEqual(original);
});

it('[AC-B1-06k#40] BR-PRICE-13：amount_unknown 转链失败仍为 50303，不取价也不签发成功尝试', async () => {
  const db = database();
  const f = fixture(db);
  const original = await unknownPricePddLink(db);
  f.convert.mockRejectedValue(new Error('synthetic-conversion-unavailable'));

  const result = await service(f).open(f.request(original.link_id));

  expect(result).toEqual({ code: 50303, data: null });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.assemble).not.toHaveBeenCalled();
  expect(f.convert).toHaveBeenCalledTimes(1);
  expect(await attempts(db, original.link_id)).toEqual([]);
  expect(await openLogs(db, original.link_id)).toEqual([
    expect.objectContaining({ result_code: 50303, quoted_price_fen: null }),
  ]);
});
