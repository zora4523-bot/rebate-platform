import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  cacheKey,
  databaseFixture,
  fixture,
  openLogs,
  service,
  source,
  attempts,
} from '../open-requote/kit.ts';
import { settled } from './kit.ts';

const database = databaseFixture(createTestDatabase);

it.each([-1, 0])(
  '[AC-B1-06e#15] BR-PRICE-13：缓存刚写入但 URL 已过期 %s 毫秒，复核失败不得外跳',
  async (offset) => {
    const f = fixture(database());
    const row = await source(f, 2990n, { platform: 'jd' });
    await f.cache.put(cacheKey(row), {
      fetchedAt: f.clock.now().toISOString(),
      jump: {
        primary: { type: 'h5', value: 'https://example.test/expired' },
        fallbacks: [],
        expire_at: new Date(f.clock.now().getTime() + offset).toISOString(),
      },
    });
    f.fetch.mockRejectedValue(new Error('synthetic requote failure'));
    const result = await settled(() => service(f).open(f.request(row.link_id)));
    expect(result).toEqual({ code: 50303, data: null });
    expect(await attempts(database(), row.link_id)).toEqual([]);
    expect(await openLogs(database(), row.link_id)).toEqual([
      expect.objectContaining({ result_code: 50303, cache_hit: false }),
    ]);
  },
);

it('[AC-B1-06e#16] BR-PRICE-13：有效期前 1ms 可降级，推进到到期后即使 TTL 未到也拒绝', async () => {
  const f = fixture(database());
  const row = await source(f, 2990n, { platform: 'pdd' });
  const jump = {
    primary: { type: 'h5' as const, value: 'https://example.test/expiring' },
    fallbacks: [],
    expire_at: new Date(f.clock.now().getTime() + 3001).toISOString(),
  };
  await f.cache.put(cacheKey(row), { fetchedAt: f.clock.now().toISOString(), jump });
  f.fetch.mockRejectedValue(new Error('synthetic requote failure'));
  const open = service(f);
  f.clock.advanceMs(3000);
  const before = await settled(() => open.open(f.request(row.link_id)));
  expect(before).toMatchObject({ code: 0, data: { requote_failed: true, jump } });
  f.clock.advanceMs(3001);
  const after = await settled(() => open.open(f.request(row.link_id)));
  expect(after).toEqual({ code: 50303, data: null });
});

it('[AC-B1-06e#17] BR-ATTR-05：links.expire_at 不阻止同一 link 重新转链，但过期 URL 缓存不得复用', async () => {
  const f = fixture(database());
  const row = await source(f, 2990n, { platform: 'jd' });
  const now = f.clock.now().toISOString();
  await f.cache.put(cacheKey(row), {
    fetchedAt: now,
    jump: {
      primary: { type: 'h5', value: 'https://example.test/expired' },
      fallbacks: [],
      expire_at: now,
    },
  });
  await database()
    .updateTable('links')
    .set({ expire_at: now })
    .where('link_id', '=', row.link_id)
    .execute();
  const fresh = {
    primary: { type: 'h5' as const, value: 'https://example.test/refreshed' },
    fallbacks: [],
    expire_at: new Date(f.clock.now().getTime() + 900000).toISOString(),
  };
  f.convert.mockResolvedValue(fresh);
  const result = await settled(() => service(f).open(f.request(row.link_id)));
  expect(result).toMatchObject({ code: 0, data: { jump: fresh, new_link_id: null } });
  expect(f.convert).toHaveBeenCalledTimes(1);
  expect(f.cache.put).toHaveBeenLastCalledWith(cacheKey(row), { fetchedAt: now, jump: fresh });
});
