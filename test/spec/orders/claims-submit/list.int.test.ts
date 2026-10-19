import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, acquireTestRedis, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createRedisHandle,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { memoryLogger, redisConnection, type TestRedis } from '../../identity/sms-codes/kit.ts';
import { fixture, failure, success, at, PAID } from './kit.ts';

// Global setup supplies the migrated template; fixture and application use couli_app.
let database: TestDatabase | undefined;
let server: TestRedis | undefined;
let db: Kysely<DB>;
let redis: RedisHandle;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 12 });
  server = await acquireTestRedis();
  redis = (await createRedisHandle(redisConnection(server.url), {
    logger: memoryLogger().logger,
  }))!;
}, 180_000);
afterAll(async () => {
  try {
    await redis?.close();
  } finally {
    try {
      if (db) await destroyDb(db);
    } finally {
      try {
        await database?.drop();
      } finally {
        await server?.stop();
      }
    }
  }
}, 30_000);

it('[AC-B1-10b#32] GET只见本人且created_at降序、同刻id降序，items默认字符串升序', async () => {
  const f = await fixture(db, redis);
  const other = await f.user();
  const foreign = await fixture(db, redis);
  const a = await f.history(await f.seed(), { created_at: at('2028-01-15T01:00:00Z') });
  const b = await f.history(await f.seed(), { created_at: at('2028-01-15T02:00:00Z') });
  const c = await f.history(await f.seed(), { created_at: at('2028-01-15T02:00:00Z') });
  await f.history(await f.seed(), { user_id: other });
  await foreign.history(await foreign.seed());
  const page = success(await f.list());
  expect(page.items.map((r) => r.claim_id)).toEqual([b.id, c.id].sort().reverse().concat(a.id));
  expect(page.next_cursor).toBeNull();
  expect(success(await f.list({}, { ...f.subject, app_id: foreign.subject.app_id })).items).toEqual(
    [],
  );
  const extra = await f.seed({ sub_order_id: 'A' + f.subject.user_id });
  await db
    .insertInto('claim_items')
    .values({
      id: randomUUID(),
      app_id: f.subject.app_id,
      applicant_user_id: f.subject.user_id,
      claim_id: b.id,
      platform: 'jd',
      sub_order_id: extra.sub_order_id,
      order_id: extra.order_id,
      updated_at: f.clock.now(),
      decision: 'rejected',
      reject_reason: 'NO_EVIDENCE',
      decided_at: f.clock.now(),
    })
    .execute();
  const saved = success(await f.list()).items.find((r) => r.claim_id === b.id)!;
  expect(saved.items.map((r) => r.sub_order_id)).toEqual(
    saved.items.map((r) => r.sub_order_id).sort(),
  );
  expect(saved.items.find((r) => r.sub_order_id === extra.sub_order_id)).toEqual({
    sub_order_id: extra.sub_order_id,
    decision: 'rejected',
    reject_reason: 'NO_EVIDENCE',
  });
});

it('[AC-B1-10b#33] GET默认20、最大50；不透明游标跨同刻记录翻页无重复遗漏', async () => {
  const f = await fixture(db, redis);
  const ids: string[] = [];
  for (let i = 0; i < 53; i++) ids.push((await f.history(await f.seed())).id);
  ids.sort().reverse();
  const first = success(await f.list());
  expect(first.items.map((r) => r.claim_id)).toEqual(ids.slice(0, 20));
  expect(first.next_cursor).toEqual(expect.any(String));
  const second = success(await f.list({ cursor: first.next_cursor!, limit: 20 }));
  expect(second.items.map((r) => r.claim_id)).toEqual(ids.slice(20, 40));
  const third = success(await f.list({ cursor: second.next_cursor!, limit: 20 }));
  expect(third.items.map((r) => r.claim_id)).toEqual(ids.slice(40));
  expect(third.next_cursor).toBeNull();
  const max = success(await f.list({ limit: 50 }));
  expect(max.items).toHaveLength(50);
  expect(max.next_cursor).toEqual(expect.any(String));
  expect(
    success(await f.list({ cursor: max.next_cursor!, limit: 50 })).items.map((r) => r.claim_id),
  ).toEqual(ids.slice(50));
});

it.each(['%bad', 'e30', Buffer.from('{"id":"x","created_at":"y"}').toString('base64url')])(
  '[AC-B1-10b#34] GET不可读游标%s返回20001 fields=[cursor]',
  async (cursor) => {
    const f = await fixture(db, redis);
    failure(await f.list({ cursor }), 20001, { fields: ['cursor'] });
    expect(await f.count()).toBeNull();
  },
);

it('[AC-B1-10b#35] 列表包含终态原status、decision、reason且返回值不泄漏内部字段', async () => {
  const f = await fixture(db, redis);
  const row = await f.seed();
  const history = await f.history(
    row,
    { status: 'rejected', evidence_level: 'none' },
    { decision: 'rejected', reject_reason: 'NO_EVIDENCE', decided_at: f.clock.now() },
  );
  const page = success(await f.list());
  expect(page).toEqual({
    next_cursor: null,
    items: [
      {
        claim_id: history.id,
        platform: 'jd',
        order_no: row.sub_order_id,
        paid_date: PAID,
        status: 'rejected',
        created_at: f.clock.now().toISOString(),
        items: [
          { sub_order_id: row.sub_order_id, decision: 'rejected', reject_reason: 'NO_EVIDENCE' },
        ],
      },
    ],
  });
});

it('[AC-B1-10b#36] GET不受提交开关、风险与当日数量限制；无更多游标为null', async () => {
  const f = await fixture(db, redis);
  f.settings.set('claims.enabled', false);
  await f.setCount(10);
  for (let i = 0; i < 5; i++) await f.history(await f.seed());
  const page = success(await f.list({ limit: 5 }));
  expect(page.items).toHaveLength(5);
  expect(page.next_cursor).toBeNull();
  expect(await f.count()).toBe('10');
});
