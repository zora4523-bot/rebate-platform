import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../open-requote/kit.ts';
import { compose, setup } from '../open-taobao/kit.ts';
import { conflict, mirrorTenant, newAccount, TIMEOUT } from './records.ts';

const database = databaseFixture(createTestDatabase);

it.each(
  (['taobao', 'pdd'] as const).flatMap((platform) =>
    (['user', 'platform', 'app', 'resolved'] as const).map((scope) => ({ platform, scope })),
  ),
)(
  '[AC-B1-06z#8] $platform 隔离 $scope：无匹配未解决行保留客户端原因，有匹配行才覆盖',
  async ({ platform, scope }) => {
    const f = await setup(database(), 'detail', platform);
    const subject = { appId: f.appId, userId: f.a, platform, accountId: f.account };
    const now = f.f.clock.now();
    if (scope === 'user') {
      await conflict(f.db, { ...subject, userId: f.b }, now);
    } else if (scope === 'platform') {
      const otherPlatform = platform === 'taobao' ? 'pdd' : 'taobao';
      const accountId = await newAccount(f.db, f.appId, otherPlatform, now);
      await conflict(f.db, { ...subject, platform: otherPlatform, accountId }, now);
    } else if (scope === 'app') {
      await conflict(f.db, await mirrorTenant(f.db, subject, now), now);
    } else {
      for (const resolution of ['already_active', 'bound_active']) {
        await conflict(f.db, subject, now, { resolved_at: now, resolution });
      }
    }
    const open = compose(f);
    const request = () =>
      f.request({ noRebate: true, noRebateReason: 'auth_failed', client: 'ios' });
    expect((await open(request())).envelope.code).toBe(0);
    const first = await f.logs();
    expect(first).toEqual([expect.objectContaining({ no_rebate_reason: 'auth_failed' })]);
    f.f.clock.advanceMs(3001);
    // Deliberately use a different account: lookup scope is user + platform, not current account.
    const accountId = await newAccount(f.db, f.appId, platform, f.f.clock.now());
    await conflict(f.db, { ...subject, accountId }, f.f.clock.now());
    expect((await open(request())).envelope.code).toBe(0);
    const after = await f.logs();
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(first[0]);
    expect(after[1]).toMatchObject({ no_rebate_reason: 'relation_conflict' });
  },
  TIMEOUT,
);

it.each(['taobao', 'pdd'] as const)(
  '[AC-B1-06z#9] %s 打开别人的非分享快照：按当前请求用户查冲突，原 link 不变',
  async (platform) => {
    const f = await setup(database(), 'detail', platform);
    const subject = { appId: f.appId, userId: f.a, platform, accountId: f.account };
    await conflict(f.db, subject, f.f.clock.now());
    f.opener(f.b);
    const before = await f.links();
    const open = compose(f);
    const request = () =>
      f.request({ noRebate: true, noRebateReason: 'auth_failed', client: 'ios' });
    expect((await open(request())).envelope.code).toBe(0);
    expect(await f.logs()).toEqual([
      expect.objectContaining({
        opener_user_id: f.b,
        no_rebate: true,
        no_rebate_reason: 'auth_failed',
      }),
    ]);
    f.f.clock.advanceMs(3001);
    await conflict(f.db, { ...subject, userId: f.b }, f.f.clock.now());
    expect((await open(request())).envelope.code).toBe(0);
    expect((await f.logs())[1]).toMatchObject({
      opener_user_id: f.b,
      no_rebate: true,
      no_rebate_reason: 'relation_conflict',
    });
    expect(await f.links()).toEqual(before);
  },
  TIMEOUT,
);
