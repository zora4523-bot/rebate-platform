import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from '../open-requote/kit.ts';
import { compose, setup } from '../open-taobao/kit.ts';
import { conflict, TIMEOUT } from './records.ts';

const database = databaseFixture(createTestDatabase);

it.each(['taobao', 'pdd'] as const)(
  '[AC-B1-06z#10] %s 他人及游客打开分享链接忽略 no_rebate，自开才读冲突',
  async (platform) => {
    const f = await setup(database(), 'share', platform);
    await f.bind('active');
    for (const userId of [f.a, f.b]) {
      await conflict(
        f.db,
        { appId: f.appId, userId, platform, accountId: f.account },
        f.f.clock.now(),
      );
    }
    const open = compose(f);
    for (const userId of [f.b, null]) {
      f.opener(userId);
      const result = await open(f.request({ noRebate: true, noRebateReason: 'auth_failed' }));
      expect(result.envelope.code).toBe(0);
      expect((await f.logs()).at(-1)).toMatchObject({
        user_id: f.a,
        opener_user_id: userId,
        no_rebate: false,
        no_rebate_reason: null,
      });
      f.f.clock.advanceMs(3001);
    }
    const shared = await f.logs();
    f.opener(f.a);
    const own = await open(f.request({ noRebate: true, noRebateReason: 'auth_declined' }));
    expect(own.envelope.code).toBe(0);
    const logs = await f.logs();
    expect(logs.slice(0, 2)).toEqual(shared);
    expect(logs.at(-1)).toMatchObject({
      user_id: f.a,
      opener_user_id: f.a,
      no_rebate: true,
      no_rebate_reason: 'relation_conflict',
    });
  },
  TIMEOUT,
);

it.each([
  ['absent', 30101],
  ['invalid', 30102],
] as const)(
  '[AC-B1-06z#11] 淘宝 %s 站长授权失效优先于冲突，无外跳；恢复可用后才判 relation_conflict',
  async (status, code) => {
    const f = await setup(database());
    await f.bind(status);
    await conflict(
      f.db,
      {
        appId: f.appId,
        userId: f.a,
        platform: 'taobao',
        accountId: f.account,
      },
      f.f.clock.now(),
    );
    await f.db
      .updateTable('union_accounts')
      .set({ auth_status: 'expired' })
      .where('id', '=', f.account)
      .execute();
    const open = compose(f);
    const result = await open(f.request({ noRebate: true, noRebateReason: 'auth_failed' }));
    expect(result).toMatchObject({
      status: 422,
      envelope: { code, data: { reason: 'auth_unavailable' } },
    });
    expect(result.envelope.data).not.toHaveProperty('jump');
    expect(await f.attempts()).toEqual([]);
    const rejected = await f.logs();
    expect(
      rejected.every(
        (row) => row.result_code !== 0 && row.no_rebate_reason !== 'relation_conflict',
      ),
    ).toBe(true);
    f.f.clock.advanceMs(3001);
    await f.db
      .updateTable('union_accounts')
      .set({ auth_status: 'active' })
      .where('id', '=', f.account)
      .execute();
    expect((await open(f.request({ noRebate: true }))).envelope.code).toBe(0);
    const after = await f.logs();
    expect(after.slice(0, rejected.length)).toEqual(rejected);
    expect(after.at(-1)).toMatchObject({ result_code: 0, no_rebate_reason: 'relation_conflict' });
    expect(await f.attempts()).toHaveLength(1);
  },
  TIMEOUT,
);

it.each(['taobao', 'pdd'] as const)(
  '[AC-B1-06z#12] %s 普通返利打开不记录原因，只有真正无返利打开才覆盖',
  async (platform) => {
    const f = await setup(database(), 'detail', platform);
    await f.bind('active');
    await conflict(
      f.db,
      {
        appId: f.appId,
        userId: f.a,
        platform,
        accountId: f.account,
      },
      f.f.clock.now(),
    );
    const open = compose(f);
    expect((await open(f.request({ noRebate: false }))).envelope.code).toBe(0);
    expect(await f.logs()).toEqual([
      expect.objectContaining({ no_rebate: false, no_rebate_reason: null }),
    ]);
    f.f.clock.advanceMs(3001);
    expect((await open(f.request({ noRebate: true }))).envelope.code).toBe(0);
    expect((await f.logs()).at(-1)).toMatchObject({
      no_rebate: true,
      no_rebate_reason: 'relation_conflict',
    });
  },
  TIMEOUT,
);
