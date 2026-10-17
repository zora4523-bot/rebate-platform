import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { at, ATTR, fixture, pipeline, snapshot } from './kit.ts';

let database: TestDatabase | undefined;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);
afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 30_000);

it.each([
  { platform: 'pdd' as const, params: '{"app":"n","uid":12345678}', sub: null },
  { platform: 'pdd' as const, params: '{"app":"n","uid":"zzzz9999"}', sub: null },
  { platform: 'jd' as const, params: null, sub: 'bad' },
  { platform: 'jd' as const, params: null, sub: 'n_zzzz9999_link' },
])(
  '[AC-B1-08h#36] $platform 参数无效或用户不存在进入未归因池，首次计一次',
  async ({ platform, params, sub }) => {
    const f = await fixture(db, {
      platform,
      attr_params: { custom_parameters: params, sub_union_id: sub, relation_id: null },
    });
    const p = await pipeline(f.deps);
    expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
    const before = await snapshot(db, f.ctx.app_id);
    expect(before.orders[0]).toMatchObject({
      user_id: null,
      user_basis: null,
      locked: false,
      rebate_status: 'UNATTRIBUTED',
      buy_type: 'share',
      scene_basis: 'pid',
      custom_params: params,
      sub_union_id: sub,
    });
    expect(before.counters).toEqual([
      expect.objectContaining({
        app_id: f.ctx.app_id,
        platform,
        counter: 'attr_param_invalid',
        count: 1n,
        day: '2026-10-16',
      }),
    ]);
    expect(f.onImported.mock.calls[0]?.[1]).toMatchObject({ attributed: false });
    f.clock.advanceMs(86_400_000);
    expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'unchanged' });
    expect(await snapshot(db, f.ctx.app_id)).toEqual(before);
    expect(f.onImported).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-08h#37] 京东有效 attr_code 只查本 App，已注销但仍存在的用户照常归属', async () => {
  const f = await fixture(db, {
    platform: 'jd',
    attr_params: { sub_union_id: 'n_abcd1234_link', custom_parameters: null, relation_id: null },
  });
  await db.updateTable('users').set({ status: 'deleted' }).where('id', '=', f.userId).execute();
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  expect((await snapshot(db, f.ctx.app_id)).orders[0]).toMatchObject({
    user_id: f.userId,
    user_basis: 'param',
  });
  expect(f.findUser).toHaveBeenCalledExactlyOnceWith({ appId: f.ctx.app_id, attrCode: 'abcd1234' });
});

it('[AC-B1-08h#38] 同一个 attr_code 在另一 App 存在不能替本 App 归属', async () => {
  const f = await fixture(db);
  const other = await fixture(db);
  await db.updateTable('users').set({ attr_code: 'zzzz9999' }).where('id', '=', f.userId).execute();
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  const s = await snapshot(db, f.ctx.app_id);
  expect(s.orders[0]?.user_id).toBeNull();
  expect(s.orders[0]?.user_id).not.toBe(other.userId);
  expect(s.counters[0]?.counter).toBe('attr_param_invalid');
});

it.each([null, 'missing-relation'])(
  '[AC-B1-08h#39] 淘宝 relation_id=%s 缺绑定只计 attr_binding_miss',
  async (relation_id) => {
    const f = await fixture(db, {
      platform: 'taobao',
      attr_params: { relation_id, sub_union_id: null, custom_parameters: null },
    });
    const p = await pipeline(f.deps);
    expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
    const s = await snapshot(db, f.ctx.app_id);
    expect(s.orders[0]).toMatchObject({
      user_id: null,
      user_basis: null,
      locked: false,
      relation_id,
    });
    expect(s.counters).toEqual([
      expect.objectContaining({
        platform: 'taobao',
        counter: 'attr_binding_miss',
        day: '2026-10-16',
        count: 1n,
      }),
    ]);
    expect(f.findUser).not.toHaveBeenCalled();
    if (relation_id === null) expect(f.findBindings).not.toHaveBeenCalled();
    else
      expect(f.findBindings).toHaveBeenCalledExactlyOnceWith({
        appId: f.ctx.app_id,
        unionAccountId: f.ctx.union_account_id,
        relationId: relation_id,
      });
    expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'unchanged' });
    expect(await snapshot(db, f.ctx.app_id)).toEqual(s);
  },
);

it('[AC-B1-08h#40] 淘宝按定金 attr_at 查历史绑定，边界命中，不按尾款或当前时间', async () => {
  const f = await fixture(db, {
    platform: 'taobao',
    deposit_paid_at: at(ATTR),
    paid_at: at('2026-10-17T09:10:11.000Z'),
    attr_params: { relation_id: 'relation-a', sub_union_id: null, custom_parameters: null },
  });
  const otherUser = randomUUID();
  await db
    .insertInto('users')
    .values({
      id: otherUser,
      app_id: f.ctx.app_id,
      nickname: 'second',
      avatar: '',
      invite_code: 'inv99999',
      attr_code: 'bbbb2222',
      level: 'member',
      register_method: 'synthetic',
      created_at: at('2026-09-05T06:07:08.000Z'),
      updated_at: at('2026-09-06T07:08:09.000Z'),
    })
    .execute();
  f.findBindings.mockResolvedValue([
    {
      user_id: f.userId,
      bound_at: at(ATTR),
      released_at: at('2026-10-15T17:01:02.000Z'),
      cooldown_until: at('2026-10-16T18:02:03.000Z'),
    },
    {
      user_id: otherUser,
      bound_at: at('2026-10-16T19:03:04.000Z'),
      released_at: null,
      cooldown_until: null,
    },
  ]);
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  const s = await snapshot(db, f.ctx.app_id);
  expect(s.orders[0]).toMatchObject({ user_id: f.userId, user_basis: 'param', attr_at: at(ATTR) });
  expect(s.counters).toEqual([]);
  expect(f.findBindings).toHaveBeenCalledExactlyOnceWith({
    appId: f.ctx.app_id,
    unionAccountId: f.ctx.union_account_id,
    relationId: 'relation-a',
  });
});

it.each([false, true])(
  '[AC-B1-08h#41] 淘宝多条有效绑定不同用户=%s：同用户归属，冲突告警且不计 miss',
  async (conflict) => {
    const f = await fixture(db, {
      platform: 'taobao',
      attr_params: { relation_id: 'relation-a', sub_union_id: null, custom_parameters: null },
    });
    const otherUser = randomUUID();
    await db
      .insertInto('users')
      .values({
        id: otherUser,
        app_id: f.ctx.app_id,
        nickname: 'second',
        avatar: '',
        invite_code: 'inv22222',
        attr_code: 'bbbb2222',
        level: 'member',
        register_method: 'synthetic',
        created_at: at('2026-09-07T08:09:10.000Z'),
        updated_at: at('2026-09-08T09:10:11.000Z'),
      })
      .execute();
    f.findBindings.mockResolvedValue([
      {
        user_id: f.userId,
        bound_at: at('2026-10-10T01:02:03.000Z'),
        released_at: null,
        cooldown_until: null,
      },
      {
        user_id: conflict ? otherUser : f.userId,
        bound_at: at('2026-10-11T02:03:04.000Z'),
        released_at: null,
        cooldown_until: null,
      },
    ]);
    const p = await pipeline(f.deps);
    expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
    const s = await snapshot(db, f.ctx.app_id);
    expect(s.orders[0]).toMatchObject({
      user_id: conflict ? null : f.userId,
      user_basis: conflict ? null : 'param',
    });
    expect(s.counters).toEqual([]);
    if (conflict) {
      expect(f.logger.error).toHaveBeenCalled();
      expect(JSON.stringify(f.logger.error.mock.calls)).toContain('attr_binding_conflict');
    } else expect(f.logger.error).not.toHaveBeenCalled();
  },
);

it('[AC-B1-08h#42] 未归因仍写参数场景；query 按默认 self/fallback 并告警', async () => {
  const f = await fixture(db, {
    attr_params: { relation_id: null, sub_union_id: null, custom_parameters: '{"sc":"share"}' },
  });
  f.findPid.mockResolvedValue([{ status: 'retired', pid_scene: 'fallback', site_id: null }]);
  const p = await pipeline(f.deps);
  expect(await p.process(f.incoming, f.ctx)).toMatchObject({ kind: 'inserted' });
  expect((await snapshot(db, f.ctx.app_id)).orders[0]).toMatchObject({
    user_id: null,
    buy_type: 'share',
    scene_basis: 'param',
  });
  f.findPid.mockResolvedValue([{ status: 'pending', pid_scene: 'query', site_id: null }]);
  expect(
    await p.process({ ...f.incoming, sub_order_id: `${f.incoming.sub_order_id}-query` }, f.ctx),
  ).toMatchObject({ kind: 'inserted' });
  expect(
    (await snapshot(db, f.ctx.app_id)).orders.find((r) => r.sub_order_id.endsWith('-query')),
  ).toMatchObject({ buy_type: 'self', scene_basis: 'fallback' });
  expect(f.logger.warn).toHaveBeenCalled();
});
