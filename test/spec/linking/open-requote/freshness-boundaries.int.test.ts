import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
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

it.each([
  [299999, false],
  [300000, false],
  [300001, true],
] as const)(
  '[AC-B1-06k#34] BR-PRICE-20：配置窗口 300 秒，快照年龄 %s 毫秒，实时取价=%s',
  async (age, fetchRequired) => {
    const db = database();
    const f = fixture(db);
    f.config.set('link.open.requote_after_sec', 300);
    const quotedAt = new Date(f.clock.now().getTime() - age).toISOString();
    const original = await source(f, 2990n, { quoted_at: quotedAt });
    reprice(f, 3090n);

    const result = success(await service(f).open(f.request(original.link_id)));

    expect(result).toMatchObject({
      old_final_price_fen: '2990',
      new_final_price_fen: fetchRequired ? '3090' : '2990',
      price_changed: fetchRequired,
      requote_failed: false,
      quoted_at: fetchRequired ? f.clock.now().toISOString() : quotedAt,
    });
    expect(f.fetch).toHaveBeenCalledTimes(fetchRequired ? 1 : 0);
    // The freshness permission concerns prices; an uncached jump still needs conversion.
    expect(f.convert).toHaveBeenCalledTimes(1);
    expect(f.configValue).toHaveBeenCalledWith('register-app', 'link.open.requote_after_sec');
    expect(await stored(db, original.link_id)).toEqual(original);
    if (fetchRequired) {
      expect(result.new_link_id).toEqual(expect.any(String));
      expect(await stored(db, result.new_link_id!)).toMatchObject({
        quoted_final_price_fen: 3090n,
      });
    }
  },
);

it.each([
  [undefined, 900000, true],
  [undefined, 900001, false],
  [60, 60000, true],
  [60, 60001, false],
] as const)(
  '[AC-B1-06k#35] BR-PRICE-13/20：缓存配置 %s 秒、年龄 %s 毫秒，取价成功时缓存可用=%s',
  async (ttl, age, cacheHit) => {
    const db = database();
    const f = fixture(db);
    if (ttl !== undefined) f.config.set('link.convert_cache_ttl_sec', ttl);
    const original = await source(f);
    await f.cache.put(cacheKey(original), {
      jump: jump('synthetic-previous-conversion'),
      fetchedAt: new Date(f.clock.now().getTime() - age).toISOString(),
    });
    reprice(f, 3090n);

    const result = success(await service(f).open(f.request(original.link_id)));

    expect(result).toMatchObject({
      old_final_price_fen: '2990',
      new_final_price_fen: '3090',
      price_changed: true,
      requote_failed: false,
      jump: cacheHit ? jump('synthetic-previous-conversion') : jump(),
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.convert).toHaveBeenCalledTimes(cacheHit ? 0 : 1);
    expect(await openLogs(db, result.new_link_id!)).toEqual([
      expect.objectContaining({ cache_hit: cacheHit, result_code: 0 }),
    ]);
  },
);

it('[AC-B1-06k#36] BR-PRICE-20：窗口根据原 quoted_at 计时，成功 open 不续期', async () => {
  const db = database();
  const f = fixture(db);
  f.config.set('link.open.requote_after_sec', 300);
  const original = await source(f, 2990n, {
    quoted_at: new Date(f.clock.now().getTime() - 299000).toISOString(),
  });
  const s = service(f);
  expect(success(await s.open(f.request(original.link_id))).new_final_price_fen).toBe('2990');
  expect(f.fetch).not.toHaveBeenCalled();

  f.clock.advanceMs(3001);
  reprice(f, 3090n);
  const after = success(await s.open(f.request(original.link_id)));

  expect(after).toMatchObject({
    old_final_price_fen: '2990',
    new_final_price_fen: '3090',
    price_changed: true,
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(await stored(db, original.link_id)).toEqual(original);
});
