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
import { withHttp, answer } from '../claims-submit/http-kit.ts';
import { PAID, at } from '../claims-submit/kit.ts';
import { fixture, persisted } from './db-kit.ts';

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

it('[AC-B1-10c#43] 两个strong子项才auto_matched，各自只存同商品引用，MVP不自动批准', async () => {
  const f = await fixture(db, redis);
  const parent = randomUUID();
  await f.seed({ parent_order_id: parent, sub_order_id: 'A', product_key: 'tb:123' });
  await f.seed({ parent_order_id: parent, sub_order_id: 'B', product_key: 'tb:456' });
  const a = await f.log({ product_key: 'tb:123' });
  const b = await f.log({ product_key: 'tb:456', event: 'convert' });
  await f.log({ product_key: 'tb:other' });
  await db
    .insertInto('config_items')
    .values({
      app_id: f.subject.app_id,
      key: 'claim.auto_approve_strong',
      value: true,
      updated_by: 'synthetic-evidence',
    })
    .execute();
  await withHttp(
    { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
    async (send) => {
      const response = await send({ platform: 'taobao', order_no: parent, paid_date: PAID });
      await answer(response, 0);
      expect(response.json().data).toMatchObject({ status: 'auto_matched' });
      await persisted(f, ['strong', 'strong'], [[String(a.id)], [String(b.id)]]);
    },
  );
}, 30_000);

it.each([
  ['taobao', 'tb:123'],
  ['pdd', 'pdd:123'],
] as const)(
  '[AC-B1-10c#29] AC-S1-26-TB① 真实装配%s商品键空时推导strong；POST/GET与重放同终态',
  async (platform, key) => {
    const f = await fixture(db, redis);
    const row = await f.seed({ platform, product_key: null });
    const hit = await f.log({ platform, product_key: key });
    const before = await db
      .selectFrom('orders')
      .selectAll()
      .where('order_id', '=', row.order_id)
      .execute();
    await withHttp(
      { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
      async (send, logs) => {
        const payload = { platform, order_no: row.sub_order_id, paid_date: PAID };
        const idempotencyKey = randomUUID();
        const first = await send(payload, { key: idempotencyKey });
        await answer(first, 0);
        expect(first.json().data).toMatchObject({ status: 'auto_matched' });
        await persisted(f, ['strong'], [[String(hit.id)]]);
        // A later GET or replay must not recalculate evidence or update row versions.
        f.clock.advanceMs(1000);
        expect((await send(payload, { key: idempotencyKey })).body).toBe(first.body);
        const page = await send();
        await answer(page, 0, undefined, 'GET');
        expect(page.json().data).toEqual({ items: [first.json().data], next_cursor: null });
        expect(await f.claims()).toHaveLength(1);
        expect((await f.items())[0]?.row_version).toBe(1);
        expect(await f.count()).toBeNull();
        expect(
          await db.selectFrom('orders').selectAll().where('order_id', '=', row.order_id).execute(),
        ).toEqual(before);
        const evidenceLogs = logs
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((line) => line['module'] === 'orders');
        for (const line of evidenceLogs) {
          for (const field of [
            'user_id',
            'sub_order_id',
            'order_no',
            'link_log_id',
            'link_log_ids',
          ])
            expect(line).not.toHaveProperty(field);
          expect(JSON.stringify(line)).not.toContain(String(hit.id));
        }
      },
    );
  },
  30_000,
);

it.each([
  ['weak', 'tb:456', '2028-01-14T16:10:00.000Z'],
  ['none', 'tb:456', '2028-01-14T16:00:00.000Z'],
] as const)(
  '[AC-B1-10c#30] AC-S1-43①/BR-ATTR-18父单例：S1 strong + S2 %s取最弱，每项用自己的attr_at',
  async (level, key, attr) => {
    const f = await fixture(db, redis);
    const parent = randomUUID();
    const first = await f.seed({ sub_order_id: `S1-${parent}`, parent_order_id: parent });
    const second = await f.seed({
      sub_order_id: `S2-${parent}`,
      parent_order_id: parent,
      product_key: key,
      attr_at: at(attr),
      paid_at: at(attr),
    });
    const hit = await f.log({ created_at: at('2028-01-14T16:05:00.000Z') });
    await withHttp(
      { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
      async (send) => {
        const created = await send({ platform: 'taobao', order_no: parent, paid_date: PAID });
        await answer(created, 0);
        expect(created.json().data).toMatchObject({
          status: 'manual_review',
          items: [{ sub_order_id: first.sub_order_id }, { sub_order_id: second.sub_order_id }],
        });
        await persisted(
          f,
          ['strong', level],
          [[String(hit.id)], level === 'weak' ? [String(hit.id)] : []],
        );
      },
    );
  },
  30_000,
);

it('[AC-B1-10c#31] S3无记录none，生产成功响应不能停在submitted', async () => {
  const f = await fixture(db, redis);
  const row = await f.seed({ sub_order_id: 'S3' });
  await withHttp(
    { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
    async (send) => {
      const response = await send({
        platform: 'taobao',
        order_no: row.sub_order_id,
        paid_date: PAID,
      });
      await answer(response, 0);
      expect(response.json().data).toMatchObject({ status: 'manual_review' });
      await persisted(f, ['none'], [[]]);
    },
  );
}, 30_000);

it.each([
  [24, 'none'],
  ['24', 'strong'],
  [0, 'strong'],
  [1.5, 'strong'],
] as const)(
  '[AC-B1-10c#32] 真实装配读取attr.backfill_window_hours=%s → %s',
  async (setting, level) => {
    const f = await fixture(db, redis);
    const row = await f.seed();
    const hit = await f.log();
    await db
      .insertInto('config_items')
      .values({
        app_id: f.subject.app_id,
        key: 'attr.backfill_window_hours',
        value: setting,
        updated_by: 'synthetic-evidence',
      })
      .execute();
    await withHttp(
      { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
      async (send) => {
        const response = await send({
          platform: 'taobao',
          order_no: row.sub_order_id,
          paid_date: PAID,
        });
        await answer(response, 0);
        expect(response.json().data).toMatchObject({
          status: level === 'strong' ? 'auto_matched' : 'manual_review',
        });
        await persisted(f, [level], [level === 'strong' ? [String(hit.id)] : []]);
      },
    );
  },
  30_000,
);

it.each([
  ['列优先', 'tb:456', '123', 'weak'],
  ['推导失败', null, 'bad raw id', 'weak'],
] as const)(
  '[AC-B1-10c#33] %s：不能把其他商品或不可推导订单判strong',
  async (_name, product_key, raw_item_id, level) => {
    const f = await fixture(db, redis);
    const row = await f.seed({ product_key, raw_item_id });
    const hit = await f.log();
    await withHttp(
      { db, redisUrl: server!.url, subject: f.subject, clock: f.clock },
      async (send) => {
        await answer(
          await send({ platform: 'taobao', order_no: row.sub_order_id, paid_date: PAID }),
          0,
        );
        await persisted(f, [level], [[String(hit.id)]]);
      },
    );
  },
  30_000,
);
