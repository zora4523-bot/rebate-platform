// Real AppModule assembly: no replacement of growthReadPorts, me, guards or route handlers.
import { createDb, destroyDb } from '@couli/db';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  client,
  seed,
  success,
  unavailable,
  withHttp,
  risk,
  riskBlocked,
} from '../../growth/invites-me/kit.ts';
import { close, fixture as meFixture, open } from '../me-invite/kit.ts';
import {
  answer,
  fixture as landingFixture,
  noAccount,
  openKit,
  registered,
} from '../../growth/landing-register/kit.ts';
import { cancel, request } from './kit.ts';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let redis: Awaited<ReturnType<typeof acquireTestRedis>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
  redis = await acquireTestRedis();
}, 180_000);
afterAll(async () => {
  try {
    await redis?.stop();
  } finally {
    try {
      if (db) await destroyDb(db);
    } finally {
      await database?.drop();
    }
  }
});

it.each(['cooling', 'processing'] as const)(
  '[AC-B1-15c#13] 邀请页本人 %s 隐藏码和链接，直推仍计 cooling/deleting、不计 deleted',
  async (stage) => {
    await withHttp(db, redis.url, async (f) => {
      const owner = await seed(f);
      const c = await client(f, owner);
      const coolingChild = await seed(f, { parent: owner.uid });
      await request(f.db, f.appId, coolingChild.uid, 'cooling', f.clock.now());
      await seed(f, { parent: owner.uid, status: 'deleting' });
      await seed(f, { parent: owner.uid, status: 'deleted' });
      success(f, await c.get(), owner.code, 2);
      await request(f.db, f.appId, owner.uid, stage, f.clock.now());
      unavailable(f, await c.get(), 2);
    });
  },
);

it('[AC-B1-15c#14] 邀请页取消注销后恢复本人码；banned 拦截仍先于注销阶段查询', async () => {
  await withHttp(db, redis.url, async (f) => {
    const owner = await seed(f);
    const c = await client(f, owner);
    const rid = await request(f.db, f.appId, owner.uid, 'cooling', f.clock.now());
    unavailable(f, await c.get(), 0);
    await cancel(f.db, rid, f.clock.now());
    success(f, await c.get(), owner.code);
    await risk(f, owner, 'banned');
    const start = f.queries.length;
    riskBlocked(f, await c.get(), start);
    expect(f.queries.slice(start).join('\n')).not.toContain('deletion_requests');
  });
});

it.each(['cooling', 'processing', 'done', 'deleting'] as const)(
  '[AC-B1-15c#15] GET /v1/me 的 %s 隐藏本人码，full 与 deletion_only 一致',
  async (stage) => {
    const kit = await open(database, redis);
    try {
      const f = await meFixture(kit);
      const before = await f.get();
      expect(before.invite_code).toBe(f.inviteCode);
      if (stage === 'deleting') {
        await kit.db
          .withSchema('app')
          .updateTable('users')
          .set({ status: 'deleting' })
          .where('app_id', '=', f.appId)
          .where('id', '=', f.uid)
          .execute();
      } else {
        await request(kit.db, f.appId, f.uid, stage, kit.clock.now());
      }
      const full = await f.get();
      expect(full).toEqual({ ...before, invite_code: null });
      expect(await f.get('deletion_only')).toEqual(full);
    } finally {
      await close(kit);
    }
  },
);

it('[AC-B1-15c#16] GET /v1/me 从 cooling 撤回后两种会话均恢复邀请码，其余字段不变', async () => {
  const kit = await open(database, redis);
  try {
    const f = await meFixture(kit);
    const before = await f.get();
    const rid = await request(kit.db, f.appId, f.uid, 'cooling', kit.clock.now());
    expect((await f.get()).invite_code).toBeNull();
    await cancel(kit.db, rid, kit.clock.now());
    expect(await f.get()).toEqual(before);
    expect(await f.get('deletion_only')).toEqual(before);
  } finally {
    await close(kit);
  }
});

it('[AC-B1-15c#17] landing 真实装配拒绝 cooling，统一文案不暴露原因；取消后照常注册绑定', async () => {
  const kit = await openKit(db, database.urlFor('couli_app'), redis.url);
  try {
    const f = await landingFixture(kit);
    const rid = await request(kit.db, f.appId, f.inviter, 'cooling', kit.clock.now());
    const body = await f.sms();
    const rejected = answer(f, await f.post(body), 30401);
    expect(rejected['msg']).toBe('邀请码无效');
    expect(rejected['data']).toBeUndefined();
    expect(JSON.stringify(rejected)).not.toMatch(/cooling|deletion|注销/);
    await noAccount(f, body.phone);
    await cancel(kit.db, rid, kit.clock.now());
    answer(f, await f.post(body));
    await registered(f, body.phone);
  } finally {
    await kit.close();
  }
});
