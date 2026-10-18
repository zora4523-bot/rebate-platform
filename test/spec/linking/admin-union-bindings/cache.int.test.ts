import { expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { redisOf } from '../../admin/step-up/kit.ts';
import { setup as openSetup, compose, success } from '../open-taobao/kit.ts';
import {
  createRedisJumpCache,
  LINK_JUMP_REDIS_NAMESPACE,
} from '../../../../apps/api/src/modules/linking/infra/jump-cache.ts';
import type { LinkOpenCacheKey } from '../../../../apps/api/src/modules/linking/index.ts';
import { setup, REASON, accepted, current } from './kit.ts';

const h = useHarness();

it('[AC-F1-07c#18] reset 清除该用户各平台转链缓存，其他用户和 app 保留，下次购买 30101', async () => {
  const open = await openSetup(h.db);
  await open.bind('active');
  const s = await setup(h, {
    appId: open.appId,
    userId: open.a,
    now: open.f.clock.now().toISOString(),
  });
  const redis = (await redisOf(s.f)).namespace(LINK_JUMP_REDIS_NAMESPACE);
  const cache = createRedisJumpCache(redis, open.f.clock, { warn: vi.fn() });
  const reader = createRedisJumpCache(redis, open.f.clock, { warn: vi.fn() });
  const base: LinkOpenCacheKey = {
    appId: s.appId,
    userId: s.userId,
    platform: 'taobao',
    productKey: 'tb:synthetic',
    rawItemId: '123',
    pid: 'mm_1_2_3',
    pidScene: 'self_buy',
    noRebate: false,
  };
  const mine = [
    base,
    { ...base, platform: 'pdd' },
    { ...base, productKey: 'tb:other', variant: 'android' },
  ];
  const unrelated = [
    { ...base, userId: open.b },
    { ...base, appId: 'synthetic-other-app' },
  ];
  const cached = {
    jump: {
      primary: { type: 'h5' as const, value: 'https://example.invalid/jump' },
      fallbacks: [],
      expire_at: new Date(open.f.clock.now().getTime() + 600_000).toISOString(),
    },
    fetchedAt: open.f.clock.now().toISOString(),
  };
  for (const key of [...mine, ...unrelated]) {
    await cache.put(key, cached);
    expect(await reader.get(key)).toEqual(cached);
  }
  const purchase = compose(open, { cache });
  success(await purchase());
  const row = (await s.rows())[0]!;
  await accepted(await s.post('reset', { reason: REASON, expected_row_version: row.row_version }));
  for (const key of mine) expect(await reader.get(key)).toBeNull();
  for (const key of unrelated) expect(await reader.get(key)).toEqual(cached);
  expect(await purchase()).toMatchObject({ status: 422, envelope: { code: 30101 } });
  expect(await current(s, row.id)).toMatchObject({ status: 'released' });
});
