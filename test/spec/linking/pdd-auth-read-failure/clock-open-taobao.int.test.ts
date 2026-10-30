// B1-22u (编排裁定 D10-434 ②; BR-ID-24 ④, B1-22b): the Taobao open judges the site authorization of
// the account in use against the injected Clock. This fixture's FixedClock (2031-05-06) is later
// than the wall clock, and the account's auth_expires_at lies between the two: by the injected
// clock it has been reached, so an open without an active binding answers 30101 auth_unavailable
// and issues no state; by the wall clock it has not, which would wrongly issue an authorization
// state. The control half (not reached by the injected clock) issues the state as before.
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';
import { SystemClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { databaseFixture } from '../open-requote/kit.ts';
import { compose, failure, noAuthState, setup } from '../open-taobao/kit.ts';
import { DAY_MS, shifted } from './kit.ts';

const database = databaseFixture(createTestDatabase);

async function expiresAt(db: Kysely<DB>, appId: string, accountId: string, at: Date) {
  await db
    .updateTable('union_accounts')
    .set({ auth_expires_at: at })
    .where('app_id', '=', appId)
    .where('id', '=', accountId)
    .execute();
}

it.each(['absent', 'unbound', 'pending_auth'] as const)(
  '[B1-22u] 淘宝 open 绑定 %s：站长授权到期时刻早于注入的 FixedClock、晚于系统时间 → 按注入时钟已到期，30101 auth_unavailable、不签发 state；未到注入时钟时照常签发',
  async (binding) => {
    const f = await setup(database());
    await f.bind(binding);
    const expiry = shifted(f.f.clock, -DAY_MS);
    // The window separates the two clocks: the wall clock has not reached this instant yet.
    expect(new SystemClock().now().getTime()).toBeLessThan(expiry.getTime());
    await expiresAt(f.db, f.appId, f.account, expiry);
    const result = await compose(f)();
    await failure(result, f, 30101);
    expect(result.envelope.data).toEqual({ reason: 'auth_unavailable' });
    await noAuthState(result, f);
    expect(f.f.fetch).not.toHaveBeenCalled();

    const g = await setup(database());
    await g.bind(binding);
    await expiresAt(g.db, g.appId, g.account, shifted(g.f.clock, DAY_MS));
    const issued = await compose(g)();
    await failure(issued, g, 30101);
    expect(issued.envelope.data).toMatchObject({
      auth_url: expect.any(String),
      state: expect.any(String),
      auth_methods: ['web_code'],
    });
    const data = issued.envelope.data as { state: string };
    expect(await g.sessions()).toEqual([
      expect.objectContaining({
        state: data.state,
        app_id: g.appId,
        user_id: g.a,
        platform: 'taobao',
        link_id: g.row.link_id,
        used_at: null,
      }),
    ]);
  },
  60_000,
);
