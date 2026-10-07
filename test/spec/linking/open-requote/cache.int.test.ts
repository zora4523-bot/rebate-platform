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
  success,
  USER_A,
  USER_B,
} from './kit.ts';

const database = databaseFixture();

it.each([
  ['fetch_error', 899999, true],
  ['fetch_error', 900000, true],
  ['fetch_error', 900001, false],
  ['anomaly', 900000, true],
  ['catalog_unavailable', 900000, true],
] as const)(
  '[AC-B1-06k#13] BR-PRICE-13：%s，缓存年龄 %s 毫秒，允许降级=%s',
  async (failure, age, allowed) => {
    const db = database();
    const f = fixture(db);
    const original = await source(f);
    await f.cache.put(cacheKey(original), {
      jump: jump('synthetic-cached'),
      fetchedAt: new Date(f.clock.now().getTime() - age).toISOString(),
    });
    if (failure === 'fetch_error') f.fetch.mockRejectedValue(new Error('synthetic-fetch-failure'));
    else if (failure === 'catalog_unavailable')
      f.assemble.mockResolvedValue({ kind: 'price_unavailable' });
    else reprice(f, 0n, { price_status: 'anomaly' });
    const result = await service(f).open(f.request(original.link_id));
    if (allowed) {
      expect(success(result)).toMatchObject({
        requote_failed: true,
        jump: jump('synthetic-cached'),
        old_final_price_fen: '2990',
        price_changed: false,
      });
      expect(await attempts(db, original.link_id)).toHaveLength(1);
    } else {
      expect(result).toMatchObject({ code: 50303, data: null });
      expect(await attempts(db, original.link_id)).toEqual([]);
    }
    expect(f.convert).not.toHaveBeenCalled();
    expect(await openLogs(db, original.link_id)).toEqual([
      expect.objectContaining({ result_code: allowed ? 0 : 50303, cache_hit: allowed }),
    ]);
  },
);

it('[AC-B1-06k#14] BR-PRICE-13：复核失败且无缓存，50303、不误用 50301、不签发尝试', async () => {
  const db = database();
  const f = fixture(db);
  const original = await source(f);
  f.fetch.mockRejectedValue(new Error('synthetic-fetch-failure'));
  const result = await service(f).open(f.request(original.link_id));
  expect(result).toEqual({ code: 50303, data: null });
  expect(f.convert).not.toHaveBeenCalled();
  expect(await attempts(db, original.link_id)).toEqual([]);
});

it('[AC-B1-06k#15] BR-PRICE-13：取价成功但转链失败，50303，不返回任何成功 jump', async () => {
  const db = database();
  const f = fixture(db);
  const original = await source(f);
  reprice(f, 3090n);
  f.convert.mockRejectedValue(new Error('synthetic-convert-failure'));
  const result = await service(f).open(f.request(original.link_id));
  expect(result).toEqual({ code: 50303, data: null });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(await attempts(db, original.link_id)).toEqual([]);
  // Failed opens must not create attempts for a replacement link either.
  const logs = await db
    .selectFrom('link_logs')
    .selectAll()
    .where('event', '=', 'open')
    .where('product_key', '=', original.product_key)
    .execute();
  expect(logs).toEqual([expect.objectContaining({ result_code: 50303 })]);
  for (const log of logs) expect(await attempts(db, log.link_id!)).toEqual([]);
});

it.each(['userId', 'appId', 'pid', 'pidScene', 'noRebate'] as const)(
  '[AC-B1-06k#16] BR-PRICE-13 身份隔离：%s 不同的缓存不能在复核失败时降级',
  async (dimension) => {
    const f = fixture(database());
    const original = await source(f);
    const correct = cacheKey(original);
    const wrong = {
      ...correct,
      ...{
        userId: { userId: USER_B },
        appId: { appId: 'synthetic-other-app' },
        pid: { pid: 'synthetic-other-pid' },
        pidScene: { pidScene: 'share' },
        noRebate: { noRebate: true },
      }[dimension],
    };
    await f.cache.put(wrong, {
      jump: jump('synthetic-wrong-identity'),
      fetchedAt: f.clock.now().toISOString(),
    });
    f.fetch.mockRejectedValue(new Error('synthetic-fetch-failure'));
    const result = await service(f).open(f.request(original.link_id));
    expect(result).toEqual({ code: 50303, data: null });
    expect(f.cache.get).toHaveBeenCalledWith(expect.objectContaining(correct));
  },
);

it('[AC-B1-06k#17] BR-PRICE-13：分享缓存按快照主人隔离，不按行 user_id 或 opener 取缓存', async () => {
  const db = database();
  const f = fixture(db, { userId: USER_B });
  const original = await source(f, 2990n, {}, { scene: 'share' });
  // Redundant row owner is deliberately different from the immutable snapshot owner.
  await db
    .updateTable('links')
    .set({ user_id: USER_B })
    .where('link_id', '=', original.link_id)
    .execute();
  await f.cache.put(cacheKey(original, USER_A), {
    jump: jump('synthetic-sharer-cache'),
    fetchedAt: f.clock.now().toISOString(),
  });
  await f.cache.put(cacheKey(original, USER_B), {
    jump: jump('synthetic-opener-cache'),
    fetchedAt: f.clock.now().toISOString(),
  });
  f.fetch.mockRejectedValue(new Error('synthetic-fetch-failure'));
  const result = success(await service(f).open(f.request(original.link_id)));
  expect(result).toMatchObject({ requote_failed: true, jump: jump('synthetic-sharer-cache') });
  expect(f.cache.get).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_A }));
  expect(await openLogs(db, original.link_id)).toEqual([
    expect.objectContaining({ user_id: USER_A, opener_user_id: USER_B, cache_hit: true }),
  ]);
});

it('[AC-B1-06k#18] BR-PRICE-13：成功转换写入的缓存键包含当前身份，不跨用户复用', async () => {
  const f = fixture(database());
  const original = await source(f);
  const result = success(await service(f).open(f.request(original.link_id)));
  expect(f.cache.put).toHaveBeenCalledWith(
    expect.objectContaining(cacheKey(original)),
    expect.objectContaining({ jump: result.jump, fetchedAt: f.clock.now().toISOString() }),
  );
});

it('[AC-B1-06k#19] BR-PRICE-13/20：命中链接缓存仍实时取新价并返回新快照', async () => {
  const db = database();
  const f = fixture(db);
  const original = await source(f);
  await f.cache.put(cacheKey(original), {
    jump: jump('synthetic-cached'),
    fetchedAt: f.clock.now().toISOString(),
  });
  reprice(f, 3090n);
  const result = success(await service(f).open(f.request(original.link_id)));
  expect(result).toMatchObject({
    new_final_price_fen: '3090',
    price_changed: true,
    requote_failed: false,
    jump: jump('synthetic-cached'),
    new_link_id: expect.any(String),
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.convert).not.toHaveBeenCalled();
  expect(await openLogs(db, result.new_link_id!)).toEqual([
    expect.objectContaining({ cache_hit: true, result_code: 0 }),
  ]);
});
