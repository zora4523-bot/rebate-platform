import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  attempts,
  cacheKey,
  databaseFixture,
  deferred,
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

const database = databaseFixture(createTestDatabase);

it('[AC-B1-06k#27] BR-PRICE-13：3000ms 含边界共用结论，3001ms 重查；不同键每次签新 attempt', async () => {
  const db = database();
  const f = fixture(db);
  const original = await source(f);
  const s = service(f);
  const first = success(await s.open(f.request(original.link_id)));
  f.clock.advanceMs(3000);
  reprice(f, 3090n);
  const edge = success(await s.open(f.request(original.link_id)));
  expect(edge).toMatchObject({
    old_final_price_fen: '2990',
    new_final_price_fen: '2990',
    price_changed: false,
    jump: first.jump,
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(edge.attempt_id).not.toBe(first.attempt_id);
  expect(await attempts(db, original.link_id)).toHaveLength(2);
  expect(await openLogs(db, original.link_id)).toHaveLength(2);
  f.clock.advanceMs(1);
  const after = success(await s.open(f.request(original.link_id)));
  expect(after).toMatchObject({ new_final_price_fen: '3090', price_changed: true });
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(new Set([first.attempt_id, edge.attempt_id, after.attempt_id]).size).toBe(3);
});

it('[AC-B1-06k#28] BR-PRICE-13：窗口从首次到达计时，不从取价完成计时；可控 Promise 合并并发', async () => {
  const f = fixture(database());
  const original = await source(f);
  const s = service(f);
  const entered = deferred<void>();
  const release = deferred<void>();
  const initial = f.state.price;
  f.fetch.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return initial;
  });
  const pendingFirst = s.open(f.request(original.link_id));
  // Propagate an early rejection rather than turning a broken service into a gate timeout.
  await Promise.race([entered.promise, pendingFirst]);
  f.clock.advanceMs(1500);
  const pendingSecond = s.open(f.request(original.link_id));
  release.resolve();
  const values = (await Promise.all([pendingFirst, pendingSecond])).map(success);
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(values[0]!.jump).toEqual(values[1]!.jump);
  expect(values[0]!.attempt_id).not.toBe(values[1]!.attempt_id);
  f.clock.advanceMs(1501);
  reprice(f, 3190n);
  expect(success(await s.open(f.request(original.link_id))).new_final_price_fen).toBe('3190');
  expect(f.fetch).toHaveBeenCalledTimes(2);
});

it('[AC-B1-06k#29] 身份键变化：普通购买后立即无返利购买，共用价格但必须另算不带归因的方案', async () => {
  const db = database();
  const f = fixture(db);
  const original = await source(f);
  const s = service(f);
  const normal = success(await s.open(f.request(original.link_id)));
  const without = success(await s.open(f.request(original.link_id, { noRebate: true })));
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.convert).toHaveBeenCalledTimes(2);
  expect(f.convert).toHaveBeenLastCalledWith(expect.objectContaining({ noRebate: true }));
  expect(normal.jump).toEqual(jump('synthetic-rebate'));
  expect(without.jump).toEqual(jump('synthetic-without-attribution'));
  expect(without.attempt_id).not.toBe(normal.attempt_id);
  expect(f.cache.put).toHaveBeenLastCalledWith(
    expect.objectContaining({ ...cacheKey(original), noRebate: true }),
    expect.any(Object),
  );
  expect(await openLogs(db, original.link_id)).toEqual([
    expect.objectContaining({ no_rebate: false }),
    expect.objectContaining({ no_rebate: true }),
  ]);
});

it('[AC-B1-06k#30] 身份键变化且复核失败：无返利请求不能取得正常归因缓存', async () => {
  const f = fixture(database());
  const original = await source(f);
  await f.cache.put(cacheKey(original), { jump: jump(), fetchedAt: f.clock.now().toISOString() });
  f.fetch.mockRejectedValue(new Error('synthetic-fetch-failure'));
  const s = service(f);
  expect(success(await s.open(f.request(original.link_id))).requote_failed).toBe(true);
  // BR-PRICE-13 (planning couli#80, 2026-10-08): a no-rebate open after a failed requote may
  // either still answer 50303 or convert anew without attribution; it never reuses the normal
  // attribution cache. Both outcomes are asserted exactly (B1-06q, test-change).
  const noRebate = await s.open(f.request(original.link_id, { noRebate: true }));
  if (noRebate.code === 50303) {
    expect(noRebate).toEqual({ code: 50303, data: null });
  } else {
    expect(success(noRebate).jump).toEqual(jump('synthetic-without-attribution'));
    expect(success(noRebate).jump).not.toEqual(jump());
    expect(f.convert).toHaveBeenLastCalledWith(expect.objectContaining({ noRebate: true }));
  }
  expect(f.cache.get).toHaveBeenLastCalledWith(expect.objectContaining({ noRebate: true }));
});

it('[AC-B1-06k#31] BR-PRICE-13：两个 link 不共享单飞价格，即使商品和身份相同', async () => {
  const f = fixture(database());
  const first = await source(f);
  const second = await source(f);
  const s = service(f);
  expect(success(await s.open(f.request(first.link_id))).new_final_price_fen).toBe('2990');
  reprice(f, 3090n);
  expect(success(await s.open(f.request(second.link_id))).new_final_price_fen).toBe('3090');
  expect(f.fetch).toHaveBeenCalledTimes(2);
});

it('[AC-B1-06k#33] 单飞窗口内更换打开者，只共用价格，不复用前一用户的转链归因', async () => {
  const f = fixture(database());
  const original = await source(f);
  f.convert.mockImplementation(async (value) =>
    jump(`synthetic-${value.owner.identitySnapshot.user_id}`),
  );
  const s = service(f);
  const first = success(await s.open(f.request(original.link_id)));
  const previous = await f.current();
  f.current.mockResolvedValue({ ...previous, userId: USER_B });
  const second = success(await s.open(f.request(original.link_id)));
  expect(first.jump).toEqual(jump(`synthetic-${USER_A}`));
  expect(second.jump).toEqual(jump(`synthetic-${USER_B}`));
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.convert).toHaveBeenCalledTimes(2);
  expect(second.new_link_id).not.toBeNull();
  expect(f.cache.put).toHaveBeenLastCalledWith(
    expect.objectContaining({ userId: USER_B }),
    expect.any(Object),
  );
});
