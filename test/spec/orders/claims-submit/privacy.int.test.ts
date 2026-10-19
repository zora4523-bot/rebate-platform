import { withHttp, answer } from './http-kit.ts';
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

it('[AC-B1-10b#44] AC-S1-106⑤ 双账号差分：移除O1重放，分享单与不存在同HTTP/code/msg/data', async () => {
  // A second pristine clone omits O1 entirely: this is the post-deletion dataset.
  // Application role intentionally cannot delete orders or order_keys.
  const cleanDatabase = await createTestDatabase();
  const cleanDb = createDb({ connectionString: cleanDatabase.urlFor('couli_app'), max: 8 });
  async function replay(target: Kysely<DB>, includeShare: boolean) {
    const f = await fixture(target, redis);
    const other = { ...f.subject, user_id: await f.user() };
    if (includeShare)
      await f.seed({
        platform: 'taobao',
        sub_order_id: 'claims-O1',
        parent_order_id: 'claims-P1',
        user_id: f.subject.user_id,
        buy_type: 'share',
      });
    await f.seed({ platform: 'taobao', sub_order_id: 'claims-O3', parent_order_id: 'claims-P1' });
    const results: unknown[] = [];
    await withHttp(
      { db: target, redisUrl: server!.url, subject: f.subject, clock: f.clock },
      async (send) => {
        for (const subject of [f.subject, other]) {
          const hidden = [];
          for (const [number, date] of [
            ['claims-O1', PAID],
            ['claims-O1', '2028-01-14'],
            ['claims-nonexistent', PAID],
          ] as const) {
            const response = await send(
              { platform: 'taobao', order_no: number, paid_date: date },
              { subject },
            );
            await answer(response, 30201);
            const { code, msg, data } = response.json();
            hidden.push({ http: response.statusCode, code, msg, data });
            expect(await f.count(subject)).toBe(String(hidden.length));
          }
          expect(hidden[0]).toEqual(hidden[1]);
          expect(hidden[1]).toEqual(hidden[2]);
          const created = await send(
            { platform: 'taobao', order_no: 'claims-P1', paid_date: PAID },
            { subject },
          );
          await answer(created, 0);
          expect(created.json().data).toMatchObject({
            items: [{ sub_order_id: 'claims-O3', decision: null, reject_reason: null }],
          });
          expect(JSON.stringify(created.json())).not.toContain('claims-O1');
          expect(await f.count(subject)).toBe('3');
          const list = await send(undefined, { subject });
          await answer(list, 0, undefined, 'GET');
          expect(JSON.stringify(list.json())).not.toContain('claims-O1');
          const persisted = await target
            .selectFrom('claim_items')
            .selectAll()
            .where('app_id', '=', subject.app_id)
            .where('applicant_user_id', '=', subject.user_id)
            .execute();
          expect(persisted.map((row) => row.sub_order_id)).toEqual(['claims-O3']);
          results.push(hidden);
        }
      },
    );
    return results;
  }
  try {
    expect(await replay(db, true)).toEqual(await replay(cleanDb, false));
  } finally {
    try {
      await destroyDb(cleanDb);
    } finally {
      await cleanDatabase.drop();
    }
  }
}, 60_000);
