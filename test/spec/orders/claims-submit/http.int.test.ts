import { randomUUID } from 'node:crypto';
import { withHttp, answer, validate, contract, PATH } from './http-kit.ts';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, acquireTestRedis, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createRedisHandle,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { memoryLogger, redisConnection, type TestRedis } from '../../identity/sms-codes/kit.ts';
import { fixture, PAID } from './kit.ts';

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

it('[AC-B1-10b#37] 真实装配POST/GET符合契约，主体取token且无身份字段泄漏', async () => {
  const f = await fixture(db, redis);
  const row = await f.seed();
  const outsider = await f.user();
  await withHttp(
    { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
    async (send) => {
      const created = await send(
        { platform: 'jd', order_no: row.sub_order_id, paid_date: PAID },
        { headers: { 'x-user-id': outsider, 'x-uid': outsider } },
      );
      await answer(created, 0);
      const page = await send();
      await answer(page, 0, undefined, 'GET');
      expect(page.json().data).toEqual({ items: [created.json().data], next_cursor: null });
      expect(await f.claims()).toHaveLength(1);
      expect((await f.claims())[0]?.user_id).toBe(f.subject.user_id);
      const foreign = await send(undefined, { subject: { ...f.subject, user_id: outsider } });
      await answer(foreign, 0, undefined, 'GET');
      expect(foreign.json().data).toEqual({ items: [], next_cursor: null });
      const paths = (await contract()).paths[PATH]!;
      expect(paths.post.operationId).toBe('createOrderClaim');
      expect(paths.get.operationId).toBe('listOrderClaims');
      for (const op of [paths.post, paths.get])
        expect([undefined, 'planned']).toContain(op['x-implementation']);
    },
  );
}, 30_000);

it('[AC-B1-10b#38] 同幂等键30201原样重放不多计数；新键再计一次', async () => {
  const f = await fixture(db, redis);
  await withHttp(
    { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
    async (send) => {
      const key = randomUUID();
      const payload = { platform: 'jd', order_no: 'missing', paid_date: PAID };
      const first = await send(payload, { key });
      await answer(first, 30201);
      const replay = await send(payload, { key });
      expect(replay.statusCode).toBe(first.statusCode);
      expect(replay.body).toBe(first.body);
      expect(await f.count()).toBe('1');
      await answer(await send(payload), 30201);
      expect(await f.count()).toBe('2');
    },
  );
}, 30_000);

it('[AC-B1-10b#39] 成功响应原样幂等重放，一条claim一个item，原键不因重复项变30205', async () => {
  const f = await fixture(db, redis);
  const row = await f.seed();
  await withHttp(
    { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
    async (send) => {
      const key = randomUUID();
      const payload = { platform: 'jd', order_no: row.sub_order_id, paid_date: PAID };
      const first = await send(payload, { key });
      await answer(first, 0);
      const replay = await send(payload, { key });
      expect(replay.body).toBe(first.body);
      expect(await f.claims()).toHaveLength(1);
      expect(await f.items()).toHaveLength(1);
      expect(await f.count()).toBeNull();
      await answer(await send(payload), 30205);
      expect(await f.count()).toBe('1');
    },
  );
}, 30_000);

it('[AC-B1-10b#40] 契约20001和处理器空格20001不计数；额外身份/诊断字段拒收', async () => {
  const f = await fixture(db, redis);
  await withHttp(
    { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
    async (send) => {
      const good = { platform: 'jd', order_no: 'missing', paid_date: PAID };
      for (const payload of [
        { ...good, order_no: '' },
        { ...good, order_no: 'x'.repeat(65) },
        { ...good, paid_date: 'not-date' },
        { ...good, platform: 'fake' },
        { ...good, user_id: f.subject.user_id },
        { ...good, diagnostic: {} },
      ]) {
        const response = await send(payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe(20001);
        await validate(response, 'POST');
      }
      await answer(await send({ ...good, order_no: '   ' }), 20001, { fields: ['order_no'] });
      expect(await f.count()).toBeNull();
      expect(await f.claims()).toEqual([]);
    },
  );
}, 30_000);

it('[AC-B1-10b#41] GET cursor错误与limit边界走20001；提交Redis不可用不影响列表', async () => {
  const f = await fixture(db, redis);
  await f.history(await f.seed());
  await withHttp({ db, subject: f.subject, clock: f.clock }, async (send) => {
    await answer(await send(), 0, undefined, 'GET');
    await answer(await send(undefined, {}, '?cursor=%25bad'), 20001, { fields: ['cursor'] }, 'GET');
    for (const limit of [0, 51]) {
      const response = await send(undefined, {}, '?limit=' + limit);
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe(20001);
    }
    // Frozen no-Redis cases constrain only the code.
    expect((await send({ platform: 'jd', order_no: 'missing', paid_date: PAID })).json().code).toBe(
      50001,
    );
  });
}, 30_000);

it('[AC-B1-10b#42] HTTP中30202 reason、30204无data和30206无data按契约映射', async () => {
  const f = await fixture(db, redis);
  const row = await f.seed({ locked: true });
  await withHttp(
    { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
    async (send) => {
      await answer(
        await send({ platform: 'jd', order_no: row.sub_order_id, paid_date: '2028-01-14' }),
        30202,
        { reason: 'FACTOR_MISMATCH' },
      );
      await answer(
        await send({ platform: 'jd', order_no: row.sub_order_id, paid_date: PAID }),
        30204,
      );
      expect(await f.count()).toBe('2');
    },
  );
  await db
    .insertInto('config_items')
    .values({
      app_id: f.subject.app_id,
      key: 'claims.enabled',
      value: false,
      updated_by: 'synthetic-claims-test',
    })
    .execute();
  await withHttp(
    { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
    async (send) => {
      await answer(
        await send({ platform: 'jd', order_no: row.sub_order_id, paid_date: PAID }),
        30206,
      );
      expect(await f.count()).toBe('2');
    },
  );
}, 30_000);
