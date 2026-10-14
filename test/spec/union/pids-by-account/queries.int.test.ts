import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { harness, seedAccount, seedPid } from '../pids/kit.ts';
import { databaseFixture, outcome } from './kit.ts';

const database = databaseFixture(createTestDatabase);

for (const platform of ['taobao', 'pdd', 'jd'] as const) {
  for (const pidScene of ['self_buy', 'share', 'agent', 'taolijin', 'query'] as const) {
    it(`[AC-B1-19d#1] ${platform}/${pidScene}: 按账号筛选后取最早 active，不带账号保留旧行为`, async () => {
      const h = harness(database());
      const b = await seedAccount(h, { platform });
      h.clock.advanceMs(1_000);
      const a = await seedAccount(h, { platform });
      h.clock.advanceMs(1_000);
      const earliest = await seedPid(h, {
        platform,
        union_account_id: b.id,
        pid_scene: pidScene,
        status: 'active',
      });
      h.clock.advanceMs(1_000);
      // 创建较早但激活较晚，不能按 created_at 或随机 id 抢占。
      const later = await seedPid(h, {
        platform,
        union_account_id: a.id,
        pid_scene: pidScene,
        status: 'active',
        updated_at: new Date(h.clock.now().getTime() + 5_000),
      });
      h.clock.advanceMs(1_000);
      const chosen = await seedPid(h, {
        platform,
        union_account_id: a.id,
        pid_scene: pidScene,
        status: 'active',
      });
      const query = {
        appId: h.appId,
        platform,
        pidScene,
        purpose: pidScene === 'query' ? ('query' as const) : ('convert' as const),
      };
      const scoped = { ...query, unionAccountId: a.id };
      const result = await outcome(() => h.service.getActivePid(scoped));
      expect(result).toEqual(chosen);
      expect(result).not.toEqual(later);
      expect(await outcome(() => h.service.getActivePid(query))).toEqual(earliest);
      expect(h.verify).not.toHaveBeenCalled();
      expect(h.append).not.toHaveBeenCalled();
    }, 30_000);
  }
}

for (const missing of [
  'no-slot',
  'pending',
  'retired',
  'other-scene',
  'fallback',
  'invalid',
  'foreign-app',
  'unknown',
] as const) {
  it(`[AC-B1-19d#2] ${missing}: 指定账号不可用时返回 null，不借用其他账号或场景`, async () => {
    const h = harness(database());
    const b = await seedAccount(h);
    h.clock.advanceMs(1_000);
    const a = await seedAccount(h);
    h.clock.advanceMs(1_000);
    await seedPid(h, { union_account_id: b.id, status: 'active', pid_scene: 'share' });
    h.clock.advanceMs(1_000);
    if (missing === 'pending' || missing === 'retired') {
      await seedPid(h, { union_account_id: a.id, status: missing, pid_scene: 'share' });
    }
    if (missing === 'other-scene' || missing === 'fallback') {
      await seedPid(h, {
        union_account_id: a.id,
        status: 'active',
        pid_scene: missing === 'fallback' ? 'fallback' : 'self_buy',
      });
    }
    let unionAccountId = a.id;
    if (missing === 'invalid') unionAccountId = 'synthetic-not-a-uuid';
    if (missing === 'unknown') unionAccountId = randomUUID();
    if (missing === 'foreign-app') {
      const foreign = { ...h, appId: `${h.appId}-foreign` };
      const account = await seedAccount(foreign);
      h.clock.advanceMs(1_000);
      await seedPid(foreign, {
        union_account_id: account.id,
        status: 'active',
        pid_scene: 'share',
      });
      unionAccountId = account.id;
    }
    const query = {
      appId: h.appId,
      platform: 'jd' as const,
      pidScene: 'share' as const,
      purpose: 'convert' as const,
      unionAccountId,
    };
    expect(await outcome(() => h.service.getActivePid(query))).toBeNull();
  }, 30_000);
}

it('[AC-B1-19d#3] 账号过滤仍隔离应用、平台与用途，fallback 不参与转链', async () => {
  const h = harness(database());
  const b = await seedAccount(h);
  h.clock.advanceMs(1_000);
  const a = await seedAccount(h);
  h.clock.advanceMs(1_000);
  await seedPid(h, { union_account_id: b.id, status: 'active' });
  h.clock.advanceMs(1_000);
  const chosen = await seedPid(h, { union_account_id: a.id, status: 'active' });
  for (const pid_scene of ['fallback', 'query'] as const) {
    h.clock.advanceMs(1_000);
    await seedPid(h, { union_account_id: a.id, status: 'active', pid_scene });
  }
  const query = {
    appId: h.appId,
    platform: 'jd' as const,
    pidScene: 'self_buy' as const,
    purpose: 'convert' as const,
    unionAccountId: a.id,
  };
  const results = [];
  for (const input of [
    { ...query, appId: `${h.appId}-absent` },
    { ...query, platform: 'pdd' as const },
    { ...query, pidScene: 'fallback' as const },
    { ...query, pidScene: 'query' as const },
    { ...query, purpose: 'query' as const },
  ])
    results.push(await outcome(() => h.service.getActivePid(input)));
  expect(results).toEqual([null, null, null, null, null]);
  // 同一场景的 scoped / unscoped 成对验证，旧实现必须在账号筛选断言上红。
  expect(await outcome(() => h.service.getActivePid(query))).toEqual(chosen);
}, 30_000);
