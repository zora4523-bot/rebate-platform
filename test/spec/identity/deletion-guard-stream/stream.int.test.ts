// B1-15m §9.3: real stream bootstrap → token verification → ordered risk guard → Agent route.
// All cases contain a blocked-write control, so an unassembled ⑥ cannot make exemptions green.
// Whitelist routes belong to api: exercise stream's supplied guard list directly for those.
import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { DeletionStageChecks } from '../../../../apps/api/src/modules/identity/application/deletion-guard.ts';
import { cancel, deletion, request, userStatus } from '../deletion-guard/kit.ts';
import { READ, WRITE, member, openStream, passed, refused, type Fixture } from './kit.ts';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: ReturnType<typeof createDb>;
let f: Fixture;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  f = await openStream(db);
}, 180_000);
afterAll(async () => {
  try {
    await f?.app.close();
  } finally {
    try {
      if (db) await destroyDb(db);
    } finally {
      await database?.drop();
    }
  }
});

it('[AC-B1-15m#2] cooling 用户经真实验签令牌调 Agent 写接口 → 10007 stage=cooling', async () => {
  const c = await member(f);
  await deletion(db, c.appId, c.uid, 'cooling');
  const invalid = await c.send('POST', WRITE, 'not-a-jwt');
  expect(invalid.json()['code']).toBe(10002);
  refused(await c.send(), 'cooling');
});

it('[AC-B1-15m#3] users.status=deleting（无注销单）→ stage=processing，同用户 GET 放行', async () => {
  const c = await member(f);
  await userStatus(db, c.appId, c.uid, 'deleting');
  refused(await c.send(), 'processing');
  passed(await c.send('GET', READ));
});

it('[AC-B1-15m#4] cooling 用户同令牌 GET 放行，Agent 非 GET 仍拦截', async () => {
  const c = await member(f);
  await deletion(db, c.appId, c.uid, 'cooling');
  passed(await c.send('GET', READ));
  refused(await c.send(), 'cooling');
});

it('[AC-B1-15m#5] 无注销单与 cancelled 单均放行，新增 cooling 后拦截', async () => {
  const c = await member(f);
  passed(await c.send());
  await deletion(db, c.appId, c.uid, 'cancelled');
  passed(await c.send());
  await deletion(db, c.appId, c.uid, 'cooling');
  refused(await c.send(), 'cooling');
});

it('[AC-B1-15m#6] ⑤封禁先于⑥冷静期；相同冷静期的未封禁用户返回 10007', async () => {
  const banned = await member(f);
  const normal = await member(f);
  await deletion(db, banned.appId, banned.uid, 'cooling');
  await deletion(db, normal.appId, normal.uid, 'cooling');
  await db
    .withSchema('app')
    .insertInto('user_risk_state')
    .values({
      app_id: banned.appId,
      user_id: banned.uid,
      state: 'banned',
      reason: 'synthetic ban',
      reason_category: 'other',
      changed_by: 'B1-15m',
      changed_at: f.clock.now(),
    })
    .execute();
  const response = await banned.send();
  expect(response.statusCode).toBe(403);
  expect(response.json()['code']).toBe(10006);
  refused(await normal.send(), 'cooling');
});

it('[AC-B1-15m#7] 同应用同令牌逐请求查库：插单立即拦截，撤回后下一次写请求立即放行', async () => {
  const c = await member(f);
  passed(await c.send());
  const id = await deletion(db, c.appId, c.uid, 'cooling');
  refused(await c.send(), 'cooling');
  await cancel(db, id, f.clock.now());
  // No clock advance, application restart or token replacement to invalidate a stale result.
  passed(await c.send());
  await userStatus(db, c.appId, c.uid, 'deleting');
  refused(await c.send(), 'processing');
});

it('[AC-B1-15m#8] stream 实际供给的⑥守卫对注销白名单逐项放行', async () => {
  const c = await member(f);
  await deletion(db, c.appId, c.uid, 'cooling');
  refused(await c.send(), 'cooling');
  const supplied = f.options?.beforeRateLimitGuards;
  expect(supplied).toBeDefined();
  expect(supplied!.inject).toEqual([f.deletionToken]);
  const checks = f.app.get<DeletionStageChecks>(f.deletionToken);
  const guards = supplied!.useFactory(checks);
  expect(guards).toHaveLength(1);
  for (const path of [
    '/v1/auth/refresh',
    '/v1/auth/logout',
    '/v1/consents',
    '/v1/me/deletion/cancel',
    '/v1/idempotency-keys/abandon',
  ]) {
    const input = request(c.appId, c.uid, 'POST', path);
    for (const guard of guards) {
      await expect(
        guard.canActivate({ switchToHttp: () => ({ getRequest: () => input }) }),
        path,
      ).resolves.toBe(true);
    }
  }
});
